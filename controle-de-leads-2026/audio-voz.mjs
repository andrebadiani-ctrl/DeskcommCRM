// Mensagem de voz gravada no navegador → formato que o WhatsApp toca como "áudio de voz".
// O Chrome e o Edge gravam Opus dentro de WebM; o WhatsApp só aceita Opus dentro de Ogg.
// O som não é recodificado: os mesmos pacotes Opus mudam de embalagem (sem ffmpeg).

// ---------- leitura do WebM (EBML) ----------
const ID = {
  EBML: 0x1a45dfa3, SEGMENT: 0x18538067, CLUSTER: 0x1f43b675, TRACKS: 0x1654ae6b, TRACK_ENTRY: 0xae,
  AUDIO: 0xe1, BLOCK_GROUP: 0xa0, SIMPLE_BLOCK: 0xa3, BLOCK: 0xa1, TRACK_NUMBER: 0xd7,
  CODEC_ID: 0x86, CODEC_PRIVATE: 0x63a2, CHANNELS: 0x9f,
};
// Elementos "pasta": o leitor entra neles em vez de pular (o tamanho pode vir como "desconhecido").
const PASTAS = new Set([ID.SEGMENT, ID.CLUSTER, ID.TRACKS, ID.TRACK_ENTRY, ID.AUDIO, ID.BLOCK_GROUP]);

function lerId(buf, pos) {
  const b = buf[pos];
  const tam = b >= 0x80 ? 1 : b >= 0x40 ? 2 : b >= 0x20 ? 3 : b >= 0x10 ? 4 : 0;
  if (!tam || pos + tam > buf.length) throw new Error("WebM inválido (identificador)");
  let v = 0;
  for (let i = 0; i < tam; i++) v = v * 256 + buf[pos + i];
  return { valor: v, tam };
}

/** Inteiro de tamanho variável do EBML; `desconhecido` quando todos os bits de valor são 1. */
function lerVint(buf, pos) {
  const b = buf[pos];
  let tam = 1;
  while (tam <= 8 && !(b & (0x80 >> (tam - 1)))) tam++;
  if (tam > 8 || pos + tam > buf.length) throw new Error("WebM inválido (tamanho)");
  let v = b & (0xff >> tam);
  let todosUm = v === 0xff >> tam;
  for (let i = 1; i < tam; i++) {
    v = v * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) todosUm = false;
  }
  return { valor: v, tam, desconhecido: todosUm };
}

const lerUint = (buf, ini, fim) => {
  let v = 0;
  for (let i = ini; i < fim; i++) v = v * 256 + buf[i];
  return v;
};

function lerWebm(buf) {
  const trilhas = [];
  let trilha = null;
  const blocos = []; // { trilha, dados }
  let pos = 0;
  while (pos < buf.length) {
    if (buf.length - pos < 2) break;
    const id = lerId(buf, pos);
    const tam = lerVint(buf, pos + id.tam);
    const ini = pos + id.tam + tam.tam;
    if (id.valor === ID.TRACK_ENTRY) trilhas.push((trilha = { numero: 0, codec: "", privado: null, canais: 0 }));
    if (PASTAS.has(id.valor)) {
      pos = ini; // entra na pasta
      continue;
    }
    if (tam.desconhecido) throw new Error("WebM inválido (elemento sem tamanho)");
    const fim = Math.min(ini + tam.valor, buf.length); // gravação cortada no fim: usa o que chegou
    if (id.valor === ID.SIMPLE_BLOCK || id.valor === ID.BLOCK) {
      const num = lerVint(buf, ini);
      const flags = buf[ini + num.tam + 2];
      if ((flags >> 1) & 3) throw new Error("WebM com pacotes agrupados (lacing) não é suportado");
      const dados = buf.subarray(ini + num.tam + 3, fim);
      if (dados.length) blocos.push({ trilha: num.valor, dados });
    } else if (trilha && id.valor === ID.TRACK_NUMBER) trilha.numero = lerUint(buf, ini, fim);
    else if (trilha && id.valor === ID.CODEC_ID) trilha.codec = buf.toString("latin1", ini, fim);
    else if (trilha && id.valor === ID.CODEC_PRIVATE) trilha.privado = Buffer.from(buf.subarray(ini, fim));
    else if (trilha && id.valor === ID.CHANNELS) trilha.canais = lerUint(buf, ini, fim);
    pos = ini + tam.valor;
  }
  return { trilhas, blocos };
}

// ---------- Opus e Ogg ----------
/** Quantas amostras (a 48 kHz) um pacote Opus contém — sai do primeiro byte (TOC). */
export function amostrasOpus(pacote) {
  const toc = pacote[0];
  const config = toc >> 3;
  const ms = config < 12 ? [10, 20, 40, 60][config & 3] : config < 16 ? [10, 20][config & 1] : [2.5, 5, 10, 20][config & 3];
  const codigo = toc & 3;
  const quadros = codigo === 0 ? 1 : codigo < 3 ? 2 : (pacote[1] ?? 0) & 0x3f;
  return quadros * ms * 48;
}

const TABELA_CRC = new Uint32Array(256).map((_, i) => {
  let r = i << 24;
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  return r >>> 0;
});
function crcOgg(buf) {
  let crc = 0;
  for (const b of buf) crc = ((crc << 8) ^ TABELA_CRC[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc;
}

function paginaOgg(pacotes, { granulo, serie, sequencia, tipo }) {
  const lacos = [];
  for (const p of pacotes) {
    for (let n = p.length; ; n -= 255) {
      lacos.push(Math.min(n, 255));
      if (n < 255) break;
    }
  }
  const cab = Buffer.alloc(27 + lacos.length);
  cab.write("OggS", 0, "latin1");
  cab[5] = tipo; // 2 = primeira página, 4 = última
  cab.writeBigInt64LE(BigInt(granulo), 6);
  cab.writeUInt32LE(serie, 14);
  cab.writeUInt32LE(sequencia, 18);
  cab[26] = lacos.length;
  Buffer.from(lacos).copy(cab, 27);
  const pagina = Buffer.concat([cab, ...pacotes]);
  pagina.writeUInt32LE(crcOgg(pagina), 22);
  return pagina;
}

function cabecalhoOpus(canais) {
  const h = Buffer.alloc(19);
  h.write("OpusHead", 0, "latin1");
  h[8] = 1;
  h[9] = canais || 1;
  h.writeUInt16LE(312, 10); // atraso padrão do codificador
  h.writeUInt32LE(48000, 12);
  return h;
}

function etiquetasOpus() {
  const fornecedor = Buffer.from("Controle de Leads 2026");
  const t = Buffer.alloc(8 + 4 + fornecedor.length + 4);
  t.write("OpusTags", 0, "latin1");
  t.writeUInt32LE(fornecedor.length, 8);
  fornecedor.copy(t, 12);
  return t; // zero comentários (últimos 4 bytes)
}

/** WebM (Opus) → Ogg (Opus). Devolve o arquivo e a duração em segundos. */
export function webmParaOgg(webm) {
  const { trilhas, blocos } = lerWebm(webm);
  const trilha = trilhas.find((t) => t.codec === "A_OPUS");
  if (!trilha) throw new Error("A gravação não está em Opus");
  const pacotes = blocos.filter((b) => b.trilha === trilha.numero).map((b) => b.dados);
  if (!pacotes.length) throw new Error("A gravação está vazia");
  const cabecalho = trilha.privado?.toString("latin1", 0, 8) === "OpusHead" ? trilha.privado : cabecalhoOpus(trilha.canais);
  const preSkip = cabecalho.readUInt16LE(10);

  const serie = (Math.random() * 0xffffffff) >>> 0;
  let sequencia = 0;
  const paginas = [
    paginaOgg([cabecalho], { granulo: 0, serie, sequencia: sequencia++, tipo: 2 }),
    paginaOgg([etiquetasOpus()], { granulo: 0, serie, sequencia: sequencia++, tipo: 0 }),
  ];
  let granulo = 0;
  let lote = [];
  let segmentos = 0;
  const fechar = (ultima) => {
    paginas.push(paginaOgg(lote, { granulo, serie, sequencia: sequencia++, tipo: ultima ? 4 : 0 }));
    lote = [];
    segmentos = 0;
  };
  pacotes.forEach((p, i) => {
    const seg = Math.floor(p.length / 255) + 1;
    if (segmentos + seg > 255 || lote.length >= 50) fechar(false); // ~1 s por página
    lote.push(p);
    segmentos += seg;
    granulo += amostrasOpus(p);
    if (i === pacotes.length - 1) fechar(true);
  });
  return { ogg: Buffer.concat(paginas), segundos: Math.max(0, (granulo - preSkip) / 48000) };
}

/** Duração de um Ogg Opus pronto (o Firefox já grava assim). */
export function duracaoOgg(ogg) {
  const inicio = ogg.indexOf("OpusHead", 0, "latin1");
  const ultima = ogg.lastIndexOf("OggS", ogg.length, "latin1");
  if (inicio < 0 || ultima < 0) throw new Error("Áudio Ogg inválido");
  const granulo = Number(ogg.readBigInt64LE(ultima + 6));
  return Math.max(0, (granulo - ogg.readUInt16LE(inicio + 10)) / 48000);
}
