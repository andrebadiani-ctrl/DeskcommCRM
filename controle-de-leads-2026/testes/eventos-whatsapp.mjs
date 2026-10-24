// Testa, sem celular, como os eventos da biblioteca do WhatsApp (formato da Baileys 7) viram
// conversas e mensagens: contatos com número oculto (LID), remoteJidAlt, mapa LID↔número,
// mensagens que não puderam ser descriptografadas, temporárias, reações, grupos e mídia.
// Rode com: npm test
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Conversas } from "../conversas.mjs";
import { WhatsApp } from "../whatsapp.mjs";

const DADOS = await mkdtemp(path.join(tmpdir(), "leads-teste-"));
const wa = new WhatsApp(DADOS);
const conversas = new Conversas(DADOS); await conversas.carregar();
const msgs = [], convs = [], unif = [];
wa.on("mensagem", (m) => { msgs.push(m); conversas.registrar(m.jid, { ...m, direcao: m.fromMe ? "saida" : "entrada" }, { nova: m.nova }); });
wa.on("conversa", (c) => { convs.push(c); conversas.atualizarDados(c.jid, c); });
wa.on("unificar", ({ lid, pn }) => { unif.push([lid, pn]); conversas.unificar(lid, pn); });
const ev = new EventEmitter();
wa.ligarEventos({ ev });
const ts = (min) => Math.floor(Date.now() / 1000) - min * 60;

// 1) Histórico: contato com LID e número (v7), conversa em LID com pnJid, outra só LID, mensagens
ev.emit("messaging-history.set", {
  contacts: [{ id: "111@lid", phoneNumber: "5511999990001@s.whatsapp.net", name: "Ana (agenda)", notify: "Ana" }],
  chats: [
    { id: "111@lid", unreadCount: 2, conversationTimestamp: ts(10) },
    { id: "222@lid", pnJid: "5521988880002@s.whatsapp.net", conversationTimestamp: ts(20) },
    { id: "333@lid", conversationTimestamp: ts(30) },
    { id: "1203630@g.us", conversationTimestamp: ts(5) },
  ],
  messages: [
    { key: { remoteJid: "111@lid", id: "A1", fromMe: false }, message: { conversation: "Oi, sou a Ana" }, messageTimestamp: ts(12), pushName: "Ana" },
    { key: { remoteJid: "222@lid", id: "B1", fromMe: true }, message: { extendedTextMessage: { text: "Olá Bruno" } }, messageTimestamp: ts(21) },
    { key: { remoteJid: "333@lid", id: "C1", fromMe: false }, message: { ephemeralMessage: { message: { conversation: "msg temporária" } } }, messageTimestamp: ts(31), pushName: "Carla" },
    { key: { remoteJid: "333@lid", id: "C2", fromMe: false }, messageStubType: 2, messageStubParameters: ["No session"], messageTimestamp: ts(30) },
    { key: { remoteJid: "333@lid", id: "C3", fromMe: false }, message: { reactionMessage: { text: "👍" } }, messageTimestamp: ts(30) },
    { key: { remoteJid: "1203630@g.us", id: "G1", fromMe: false }, message: { conversation: "grupo" }, messageTimestamp: ts(5) },
  ],
});
assert.deepEqual(msgs.map((m) => m.jid), ["5511999990001@s.whatsapp.net", "5521988880002@s.whatsapp.net", "333@lid"], "conversa vai para o número quando conhecido");
assert.equal(msgs[0].telefone, "5511999990001");
assert.equal(msgs[0].jidWhatsapp, "111@lid", "guarda o endereço original para pedir histórico");
assert.equal(msgs[2].texto, "msg temporária");
assert.ok(msgs.every((m) => m.historico && !m.nova));
assert.equal(wa.diag.naoDescriptografadas, 1);
assert.equal(wa.diag.semConteudo, 1);
assert.equal(wa.diag.lotesHistorico, 1);
assert.equal(wa.diag.conversasRecebidas, 3, "grupo não conta");
console.log("1 ok: histórico em LID vai para o número; temporária lida; não-descriptografada e reação contadas; grupo fora");

// 2) Mensagem ao vivo de LID desconhecido com remoteJidAlt → aprende e junta a conversa antiga
ev.emit("messages.upsert", { type: "notify", messages: [
  { key: { remoteJid: "333@lid", remoteJidAlt: "5531977770003@s.whatsapp.net", id: "C4", fromMe: false }, message: { conversation: "Voltei!" }, messageTimestamp: ts(0), pushName: "Carla" },
] });
assert.deepEqual(unif.at(-1), ["333@lid", "5531977770003@s.whatsapp.net"]);
const carla = conversas.obter("5531977770003@s.whatsapp.net");
assert.ok(carla && !conversas.obter("333@lid"), "conversa LID juntada na do número");
assert.deepEqual(carla.mensagens.map((m) => m.id), ["C1", "C4"], "mensagens antigas e novas juntas, sem duplicar");
assert.equal(carla.naoLidas, 1); assert.ok(carla.fila, "mensagem nova entra na fila");
assert.equal(carla.telefone, "5531977770003");
console.log("2 ok: remoteJidAlt revela o número e a conversa LID é unificada");

// 3) lid-mapping.update (v7) e mensagem enviada pelo celular (append, fromMe)
ev.emit("chats.upsert", [{ id: "444@lid", conversationTimestamp: ts(1) }]);
ev.emit("messages.upsert", { type: "append", messages: [{ key: { remoteJid: "444@lid", id: "D1", fromMe: true }, message: { conversation: "mandei pelo celular" }, messageTimestamp: ts(1) }] });
assert.ok(conversas.obter("444@lid"));
ev.emit("lid-mapping.update", { lid: "444@lid", pn: "5541966660004@s.whatsapp.net" });
assert.ok(conversas.obter("5541966660004@s.whatsapp.net") && !conversas.obter("444@lid"));
ev.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: "444@lid", id: "D2", fromMe: false }, message: { conversation: "resposta" }, messageTimestamp: ts(0) }] });
assert.equal(msgs.at(-1).jid, "5541966660004@s.whatsapp.net", "depois do mapa, LID vai direto para o número");
assert.equal(msgs.find((m) => m.id === "D1").fromMe, true);
console.log("3 ok: lid-mapping.update junta e redireciona; enviada pelo celular registrada como saída");

// 4) Mídia em mensagem LID: guarda chaves para baixar
ev.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: "111@lid", id: "A2", fromMe: false }, message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 7, ptt: true, fileLength: 12345, mediaKey: Buffer.from("chave") } }, messageTimestamp: ts(0) }] });
const audio = msgs.at(-1);
assert.equal(audio.jid, "5511999990001@s.whatsapp.net"); assert.equal(audio.midia.tipo, "audio"); assert.equal(audio.midia.mimetype, "audio/ogg"); assert.ok(audio.midia.wa.message.audioMessage.mediaKey);
console.log("4 ok: áudio de contato LID vai para a conversa do número, com as chaves de download");
await conversas.salvarAgora();
await rm(DADOS, { recursive: true, force: true });
console.log("Todos os cenários passaram.");
process.exit(0);
