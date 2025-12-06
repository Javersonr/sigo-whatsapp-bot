// ============================================================================
//  BOT WHATSAPP – OCR IMAGEM + OCR PDF + ENVIO AO SIGO OBRAS (Mocha)
//  Versão alinhada com docs do SIGO – 05/12/2025
// ============================================================================

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import OpenAI from "openai";
import fetch from "node-fetch";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import os from "os";
import path from "path";
import fs from "fs/promises";
import pdfParseCjs from "pdf-parse";

// Garante que pdfParse seja SEMPRE uma função
const pdfParse =
  typeof pdfParseCjs === "function" ? pdfParseCjs : pdfParseCjs.default;


dotenv.config();

// ============================================================================
//  CONFIGURAÇÃO
// ============================================================================

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";

const VERIFY_TOKEN_META = process.env.VERIFY_TOKEN_META || "sinergia123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID || "";

// 🔹 Normaliza a MOCHA_OCR_URL
const rawMochaUrl = (process.env.MOCHA_OCR_URL || "").trim();

// Se a pessoa colocar "POST https://..." no .env, remove o "POST "
let normalizedMochaUrl = rawMochaUrl;
if (normalizedMochaUrl.toUpperCase().startsWith("POST ")) {
  normalizedMochaUrl = normalizedMochaUrl.slice(5).trim();
}

// Se continuar vazio, usa o padrão oficial
if (!normalizedMochaUrl) {
  normalizedMochaUrl = "https://sigoobras2.mocha.app/api/ocr-receber-arquivo";
}

const MOCHA_OCR_URL = normalizedMochaUrl;

const PORT = Number(process.env.PORT || 3000);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

console.log("=== VARIÁVEIS ===");
console.log("WHATSAPP_TOKEN:", WHATSAPP_TOKEN ? "OK" : "FALTANDO");
console.log("PHONE_NUMBER_ID:", PHONE_NUMBER_ID || "FALTANDO");
console.log("OPENAI_API_KEY:", OPENAI_API_KEY ? "OK" : "FALTANDO");
console.log("MOCHA_OCR_URL:", MOCHA_OCR_URL || "FALTANDO");
console.log("=================");


// Memória de OCR pendente até receber "SIM"
const ocrPendentes =
  globalThis.ocrPendentes || (globalThis.ocrPendentes = {});

// ============================================================================
//  FUNÇÃO – ENVIAR MENSAGEM DE TEXTO
// ============================================================================

async function enviarMensagemWhatsApp(to, body) {
  const url = `${GRAPH_API_BASE}/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  console.log("[WhatsApp][STATUS]", resp.status);
  console.log("[WhatsApp][RESPONSE]", data);

  return data;
}

// ============================================================================
//  BUSCAR / BAIXAR MÍDIA DO WHATSAPP
// ============================================================================

async function buscarInfoMidia(mediaId) {
  const url = `${GRAPH_API_BASE}/${mediaId}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });

  const data = await resp.json();
  return data;
}

async function baixarMidia(mediaId) {
  const info = await buscarInfoMidia(mediaId);

  const resp = await fetch(info.url, {
    method: "GET",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });

  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  return {
    buffer,
    mimeType: info.mime_type,
    fileUrl: info.url,
  };
}

// ============================================================================
//  OCR IMAGEM (OpenAI Vision)
// ============================================================================

async function processarImagem(buffer, mimeType) {
  if (!openai) {
    throw new Error("OPENAI_API_KEY não configurada.");
  }

  const b64 = buffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${b64}`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Você é um extrator de dados de comprovantes financeiros. Retorne APENAS um JSON com as chaves: fornecedor, cnpj, data, valor, descricao, texto_completo.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Extraia os dados deste comprovante:" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  let texto = resp.choices[0].message.content || "";
  texto = texto.replace(/```json/gi, "").replace(/```/g, "").trim();

  try {
    const json = JSON.parse(texto);
    return json;
  } catch {
    return {
      fornecedor: "",
      cnpj: "",
      valor: "",
      data: "",
      descricao: "",
      texto_completo: texto,
    };
  }
}

// ============================================================================
//  CONVERTER PDF -> PNG (1ª página) PARA OCR VISUAL
// ============================================================================

async function converterPdfParaPngPrimeiraPagina(buffer) {
  console.log("[OCR PDF] Convertendo PDF -> PNG (primeira página)...");
  const tmpDir = os.tmpdir();
  const pdfPath = path.join(tmpDir, `ocr_${randomUUID()}.pdf`);
  const outPrefix = pdfPath.replace(/\.pdf$/, "");

  await fs.writeFile(pdfPath, buffer);

  return new Promise((resolve, reject) => {
    const args = ["-png", "-f", "1", "-l", "1", pdfPath, outPrefix];
    const child = spawn("pdftoppm", args);

    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("close", async (code) => {
      if (code !== 0) {
        console.error("[OCR PDF] Erro pdftoppm:", stderr);
        return reject(new Error(`pdftoppm exit code ${code}`));
      }

      const pngPath = `${outPrefix}-1.png`;
      try {
        const imgBuffer = await fs.readFile(pngPath);
        console.log("[OCR PDF] PNG gerado:", pngPath);
        resolve(imgBuffer);
      } catch (err) {
        console.error("[OCR PDF] Erro lendo PNG:", err);
        reject(err);
      }
    });
  });
}

// ============================================================================
//  OCR PDF (digital + escaneado)
// ============================================================================

async function processarPdf(buffer) {
  if (!openai) {
    throw new Error("OPENAI_API_KEY não configurada.");
  }

  console.log("[OCR PDF] Tentando extrair texto via pdf-parse...");
  let textoExtraido = "";
  let ehDigital = false;

  try {
    const result = await pdfParse(buffer);
    textoExtraido = (result.text || "").trim();
    console.log(
      "[OCR PDF] Texto extraído (parcial):",
      textoExtraido.slice(0, 300)
    );

    if (textoExtraido.length > 50) {
      ehDigital = true;
    }
  } catch (err) {
    console.error("[OCR PDF] Erro pdf-parse:", err);
  }

  if (ehDigital) {
    console.log("[OCR PDF] PDF digital detectado → usando texto + GPT.");
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Você é um extrator de dados de comprovantes. Com base no texto abaixo, retorne APENAS um JSON com as chaves: fornecedor, cnpj, data, valor, descricao, texto_completo.",
        },
        {
          role: "user",
          content: textoExtraido.slice(0, 12000),
        },
      ],
    });

    let resposta = resp.choices[0].message.content || "";
    resposta = resposta.replace(/```json/gi, "").replace(/```/g, "").trim();

    try {
      const json = JSON.parse(resposta);
      json.texto_completo = textoExtraido;
      return json;
    } catch {
      return {
        fornecedor: "",
        cnpj: "",
        valor: "",
        data: "",
        descricao: "",
        texto_completo: textoExtraido,
      };
    }
  }

  console.log(
    "[OCR PDF] Pouco ou nenhum texto. Assumindo PDF escaneado → OCR visual."
  );

  try {
    const pngBuffer = await converterPdfParaPngPrimeiraPagina(buffer);
    const b64 = pngBuffer.toString("base64");
    const dataUrl = `data:image/png;base64,${b64}`;

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Você é um extrator de dados de comprovantes em PDF escaneado. Retorne APENAS um JSON com as chaves: fornecedor, cnpj, data, valor, descricao, texto_completo.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extraia os dados deste comprovante escaneado:",
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });

    let texto = resp.choices[0].message.content || "";
    texto = texto.replace(/```json/gi, "").replace(/```/g, "").trim();

    try {
      const json = JSON.parse(texto);
      json.texto_completo = texto;
      return json;
    } catch {
      return {
        fornecedor: "",
        cnpj: "",
        valor: "",
        data: "",
        descricao: "",
        texto_completo: texto,
      };
    }
  } catch (err) {
    console.error(
      "[OCR PDF] Erro ao converter PDF para PNG ou chamar Vision:",
      err
    );
    return {
      fornecedor: "",
      cnpj: "",
      valor: "",
      data: "",
      descricao: "",
      texto_completo: "",
    };
  }
}

// ============================================================================
//  HELPERS – normalizar telefone e data
// ============================================================================

function normalizarTelefone(telefone) {
  const digits = (telefone || "").toString().replace(/\D/g, "");
  // Mocha aceita só DDD+numero; docs dizem que ele já remove 55, mas ajudamos
  if (digits.startsWith("55") && digits.length > 11) return digits.slice(2);
  return digits;
}

// tenta converter "dd/mm/aaaa" -> "aaaa-mm-ddT00:00:00Z"
// se não bater, retorna original
function normalizarDataParaIso(dataStr) {
  if (!dataStr) return "";
  const s = dataStr.toString().trim();

  // já parece ISO
  if (/\d{4}-\d{2}-\d{2}T/.test(s)) return s;

  // formato brasileiro dd/mm/aaaa
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) {
    const [_, d, mth, y] = m;
    return `${y}-${mth}-${d}T00:00:00Z`;
  }

  return s;
}

// ============================================================================
//  ENVIAR PARA SIGO OBRAS (Mocha) – FORMATO DOC OFICIAL
//  Campos: telefone, arquivo_url, fornecedor, cnpj, valor, data, descricao, texto_ocr
// ============================================================================

async function enviarDadosParaMocha(pendente) {
  if (!MOCHA_OCR_URL) {
    console.error("[MOCHA] MOCHA_OCR_URL não configurada.");
    return { erro: "MOCHA_OCR_URL não configurada" };
  }

  const telefoneLimpo = normalizarTelefone(pendente.userPhone);

  let valorNumero = pendente.valor;
  if (typeof valorNumero === "string") {
    valorNumero = valorNumero.replace(/\./g, "").replace(",", ".");
  }
  valorNumero = Number(valorNumero) || 0;

  const dataIso = normalizarDataParaIso(pendente.data);

  const payload = {
    telefone: telefoneLimpo,
    arquivo_url: pendente.fileUrl || "",
    fornecedor: pendente.fornecedor || "",
    cnpj: pendente.cnpj || "",
    valor: valorNumero,
    data: dataIso || null,
    descricao: pendente.descricao || "",
    texto_ocr: pendente.texto_ocr || "",
  };

  console.log("[MOCHA][REQUEST]", payload);

  const resp = await fetch(MOCHA_OCR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const resultado = await resp.json().catch(() => ({}));
  console.log("[MOCHA][RESP]", resultado);

  return resultado;
}

// ============================================================================
//  APP HONO – ROTAS
// ============================================================================

const app = new Hono();

app.get("/", (c) => c.text("BOT OK"));

app.get("/webhook/whatsapp", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN_META) {
    return c.text(challenge || "");
  }

  return c.text("Erro na verificação do webhook", 400);
});

// ============================================================================
//  RECEBIMENTO DE MENSAGENS
// ============================================================================

app.post("/webhook/whatsapp", async (c) => {
  const body = await c.req.json().catch(() => ({}));

  const value = body.entry?.[0]?.changes?.[0]?.value;
  if (!value) {
    console.log("[WEBHOOK] Nenhum value encontrado.");
    return c.json({ status: "ignored" });
  }

  const msg = value.messages?.[0];
  if (!msg) {
    console.log("[WEBHOOK] Nenhuma mensagem encontrada.");
    return c.json({ status: "ignored" });
  }

  const from = msg.from;
  const type = msg.type;

  // ============================================================
  //  CONFIRMAÇÃO "SIM" → envia pré-lançamento para SIGO Obras
  // ============================================================

  if (type === "text") {
    const texto = msg.text.body.trim().toUpperCase();

    if (texto === "SIM") {
      const pendente = ocrPendentes[from];

      if (!pendente) {
        await enviarMensagemWhatsApp(
          from,
          "Nenhum lançamento pendente encontrado."
        );
        return c.json({ status: "ok" });
      }

      const respMocha = await enviarDadosParaMocha(pendente);

      if (respMocha?.error) {
        await enviarMensagemWhatsApp(
          from,
          `⚠ Não foi possível lançar no SIGO Obras: ${respMocha.error}`
        );
      } else {
        await enviarMensagemWhatsApp(
          from,
          "Lançamento enviado ao SIGO Obras com sucesso! ✅"
        );
      }

      delete ocrPendentes[from];
      return c.json({ status: "ok" });
    }

    await enviarMensagemWhatsApp(
      from,
      "Recebido! Envie uma imagem ou PDF de um comprovante para lançar no financeiro."
    );
    return c.json({ status: "ok" });
  }

  // ============================================================
  //  DOCUMENTO OU IMAGEM
  // ============================================================

  if (type === "image" || type === "document") {
    const mediaId = type === "image" ? msg.image.id : msg.document.id;
    const mime =
      type === "image" ? msg.image.mime_type : msg.document.mime_type;

    const midia = await baixarMidia(mediaId);

    let dados = {};

    if (mime.startsWith("image/")) {
      dados = await processarImagem(midia.buffer, mime);
    } else if (mime === "application/pdf") {
      dados = await processarPdf(midia.buffer);
    } else {
      await enviarMensagemWhatsApp(
        from,
        "Tipo de arquivo não suportado. Envie uma imagem ou PDF."
      );
      return c.json({ status: "ok" });
    }

    ocrPendentes[from] = {
      userPhone: from,
      fileUrl: midia.fileUrl,
      fornecedor: dados.fornecedor || "",
      cnpj: dados.cnpj || "",
      valor: dados.valor || "",
      data: dados.data || "",
      descricao: dados.descricao || "",
      texto_ocr: dados.texto_completo || "",
    };

    await enviarMensagemWhatsApp(
      from,
      `Recebi o seu comprovante! ✅\n\n` +
        `Fornecedor: ${dados.fornecedor || "N/D"}\n` +
        `CNPJ: ${dados.cnpj || "N/D"}\n` +
        `Data: ${dados.data || "N/D"}\n` +
        `Valor: ${dados.valor || "N/D"}\n` +
        `Descrição: ${dados.descricao || "N/D"}\n\n` +
        `Se estiver tudo certo, responda *SIM* para lançar no financeiro.`
    );

    return c.json({ status: "ok" });
  }

  // OUTROS TIPOS
  await enviarMensagemWhatsApp(
    from,
    "Envie texto, imagem ou PDF para continuar."
  );
  return c.json({ status: "ok" });
});

// ============================================================================
//  SERVIDOR
// ============================================================================

serve({ fetch: app.fetch, port: PORT });
console.log(`🚀 BOT WHATSAPP RODANDO NA PORTA ${PORT}`);
