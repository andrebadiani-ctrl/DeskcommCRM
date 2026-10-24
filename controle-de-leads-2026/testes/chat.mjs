// Testa o chat: citação recebida e enviada (formato da Baileys 7), mensagem de voz e a conversão
// WebM → Ogg da gravação. `amostras/voz-chrome.webm` foi gravado de verdade pelo Chrome
// (MediaRecorder), com os elementos de tamanho "desconhecido" que só ele produz.
// Rode com: npm test
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { amostrasOpus, duracaoOgg, webmParaOgg } from "../audio-voz.mjs";
import { WhatsApp } from "../whatsapp.mjs";

const wa = new WhatsApp(await mkdtemp(path.join(tmpdir(), "leads-chat-")));
const msgs = [];
wa.on("mensagem", (m) => msgs.push(m));
const ev = new EventEmitter();
wa.ligarEventos({ ev });
const ts = Math.floor(Date.now() / 1000);

// 1) Citações recebidas: texto respondendo a texto; áudio de voz respondendo a uma foto.
ev.emit("messages.upsert", { type: "notify", messages: [
  { key: { remoteJid: "5511999990001@s.whatsapp.net", id: "R1", fromMe: false }, messageTimestamp: ts, pushName: "Ana",
    message: { extendedTextMessage: { text: "Pode ser às 15h", contextInfo: { stanzaId: "Q1", participant: "5511900000000@s.whatsapp.net", quotedMessage: { conversation: "Qual horário fica bom?" } } } } },
  { key: { remoteJid: "5511999990001@s.whatsapp.net", id: "R2", fromMe: false }, messageTimestamp: ts, pushName: "Ana",
    message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: 4, contextInfo: { stanzaId: "Q2", quotedMessage: { imageMessage: { mimetype: "image/jpeg" } } } } } },
  { key: { remoteJid: "5511999990001@s.whatsapp.net", id: "R3", fromMe: false }, messageTimestamp: ts, pushName: "Ana", message: { conversation: "Sem citação" } },
] });
assert.deepEqual(msgs[0].citacao, { id: "Q1", texto: "Qual horário fica bom?" });
assert.equal(msgs[0].texto, "Pode ser às 15h");
assert.deepEqual(msgs[1].citacao, { id: "Q2", texto: "📷 Foto" });
assert.equal(msgs[1].midia.ptt, true);
assert.equal(msgs[2].citacao, null);
console.log("1 ok: citação recebida (texto e mídia) e mensagem sem citação");

// 2) Envio citando e mensagem de voz: o que vai para a biblioteca.
const enviados = [];
wa.sock = { sendMessage: async (jid, conteudo, opcoes) => (enviados.push({ jid, conteudo, opcoes }), { key: { id: `S${enviados.length}` } }) };
wa.status = "conectado";
await wa.enviarParaJid("5511999990001@s.whatsapp.net", "Combinado!", { citar: { id: "R1", fromMe: false, texto: "Pode ser às 15h", jidWhatsapp: "111@lid" } });
assert.deepEqual(enviados[0].opcoes.quoted, { key: { remoteJid: "111@lid", id: "R1", fromMe: false }, message: { conversation: "Pode ser às 15h" } });
await wa.enviarParaJid("5511999990001@s.whatsapp.net", "Sem citar");
assert.equal(enviados[1].opcoes, undefined);
const onda = new Uint8Array(64).fill(50);
const r = await wa.enviarMidiaParaJid("5511999990001@s.whatsapp.net", { caminho: "/tmp/x.ogg", mimetype: "audio/ogg", nome: "a.ogg", voz: true, segundos: 3.4, onda });
assert.equal(r.tipo, "audio");
assert.deepEqual({ ...enviados[2].conteudo, audio: undefined }, { audio: undefined, mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: 3, waveform: onda });
console.log("2 ok: resposta vai com a mensagem citada; voz vai como ptt com duração e forma de onda");

// 3) Gravação do Chrome (WebM) → Ogg Opus válido.
const webm = await readFile(new URL("./amostras/voz-chrome.webm", import.meta.url));
const { ogg, segundos } = webmParaOgg(webm);
assert.ok(segundos > 1.2 && segundos < 1.8, `duração ${segundos}`);
assert.equal(Math.round(duracaoOgg(ogg) * 1000), Math.round(segundos * 1000));
const paginas = [];
for (let pos = 0; pos < ogg.length; ) {
  assert.equal(ogg.toString("latin1", pos, pos + 4), "OggS", `página em ${pos}`);
  const nSeg = ogg[pos + 26];
  let tam = 27 + nSeg;
  for (let i = 0; i < nSeg; i++) tam += ogg[pos + 27 + i];
  paginas.push(ogg.subarray(pos, pos + tam));
  pos += tam;
}
// CRC de cada página, recalculado aqui de forma independente (polinômio do Ogg, bit a bit).
const crc = (buf) => {
  let c = 0;
  for (const b of buf) {
    c ^= b << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
  }
  return c >>> 0;
};
for (const [i, pg] of paginas.entries()) {
  const copia = Buffer.from(pg);
  const gravado = copia.readUInt32LE(22);
  copia.writeUInt32LE(0, 22);
  assert.equal(crc(copia), gravado, `CRC da página ${i}`);
  assert.equal(copia.readUInt32LE(18), i, "páginas em sequência");
}
assert.equal(paginas[0][5], 2, "primeira página marcada como início");
assert.equal(paginas.at(-1)[5], 4, "última página marcada como fim");
assert.equal(paginas[0].toString("latin1", 28, 36), "OpusHead");
assert.equal(paginas[1].toString("latin1", 28, 36), "OpusTags");
console.log(`3 ok: WebM do Chrome vira Ogg Opus (${paginas.length} páginas, CRC e sequência conferidos, ${segundos.toFixed(2)} s)`);

// 4) Gravação cortada no fim ainda converte; arquivo que não é Opus é recusado.
assert.ok(webmParaOgg(webm.subarray(0, webm.length - 40)).segundos > 1);
assert.throws(() => webmParaOgg(Buffer.from("isto não é um webm")));
assert.equal(amostrasOpus(Buffer.from([0xfc])), 960, "CELT 20 ms = 960 amostras");
assert.equal(amostrasOpus(Buffer.from([0x0b, 0x03])), 3 * 960, "3 quadros de 20 ms (código 3)");
console.log("4 ok: gravação cortada, arquivo inválido e duração dos pacotes Opus");
console.log("Chat: todos os cenários passaram.");
