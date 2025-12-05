// ============================================================================
//  BOT WHATSAPP – OCR IMAGEM + OCR PDF (digital + escaneado)
//  Integração direta com SIGO OBRAS (Mocha)
//  Versão Final – 06/12/2025
// ============================================================================

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import OpenAI from "openai";
import fetch from "node-fetch";
import { createRequire } from "module";

dotenv.config();

// pdf-parse só funciona via require
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

// ============================================================================
//  CONFIGURAÇÃO
// ============================================================================
const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";

const VERIFY_TOKEN_META = process.env.VERIFY_TOKEN_META || "sinergia123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID ||
  process.env.PHONE_NUMBER_ID ||
  "";

const MOCHA_OCR_URL =
  process.env.MOCHA_OCR_URL ||
  "https://sigoobras2.mocha.app/api/ocr-receber-arquivo";

const PORT = Number(process.env.PORT || 3000);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

console.log("=== VARIÁVEIS ===");
console.log("WHATSAPP_TOKEN:", WHATSAPP_TOKEN ? "OK" : "FALTANDO");
console.log("PHONE_NUMBER_ID:", PHONE_NUMBER_ID || "FALTANDO");
console.log("OPENAI_API_KEY:", OPENAI_API_KEY ? "OK" : "FALTANDO");
console.log("MOCHA_OCR_URL:", MOCHA_OCR_URL || "FALTANDO");
console.log("=================");

// Memória temporária até o usuário digitar “SIM”
const ocrPendentes =
  globalThis.ocrPendentes || (globalThis.ocrPendentes = {});

// ============================================================================
//  ENVIAR MENSAGEM TEXTO VIA WHATSAPP
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
//  BUSCAR E BAIXAR MÍDIA DO WHATSAPP
// ============================================================================
async function buscarInfoMidia(mediaId) {
  const url = `${GRAPH_API_BASE}/${mediaId}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });

  return await resp.json();
}

async function baixarMidia(mediaId) {
  const info = await buscarInfoMidia(mediaId);

  const resp = await fetch(info.url, {
    method: "GET",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });

  const arrayBuffer = await resp.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: info.mime_type,
    fileUrl: info.url,
  };
}

// ============================================================================
//  OCR DE IMAGEM – OpenAI Vision
// ============================================================================
async function processarImagem(buffer, mimeType) {
  const b64 = buffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${b64}`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Extraia dados de comprovantes e retorne JSON: fornecedor, cnpj, data, valor, descricao, texto_completo.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Extraia os dados:" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  let texto = resp.choices[0].message.content;
  texto = texto.replace(/```json/gi, "").replace(/```/g, "");

  try {
    return JSON.parse(texto);
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
//  OCR DE PDF (Digital OU Escaneado)
// ============================================================================
async function processarPdf(buffer) {
  console.log("[OCR PDF] Tentando identificar se PDF é digital...");

  let textoExtraido = "";
  try {
    const data = await pdfParse(buffer);
    textoExtraido = data.text || "";
  } catch (e) {
    console.log("[OCR PDF] pdf-parse falhou:", e.message);
  }

  const textoTratado = textoExtraido.replace(/\s+/g, "");

  // ========================================================================
  // PDF DIGITAL → Tem texto real
  // ========================================================================
  if (textoTratado.length > 20) {
    console.log("[OCR PDF] PDF digital detectado → usando GPT texto");

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Analise o texto e retorne somente JSON: fornecedor, cnpj, data, valor, descricao, texto_completo.",
        },
        {
          role: "user",
          content: textoExtraido.slice(0, 16000),
        },
      ],
    });

    let resposta = resp.choices[0].message.content;
    resposta = resposta.replace(/```json/gi, "").replace(/```/g, "");

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

  // ========================================================================
  // PDF ESCANEADO → OCR via OpenAI Vision
  // ========================================================================
  console.log("[OCR PDF] PDF escaneado → usando GPT visão");

  const b64 = buffer.toString("base64");
  const dataUrl = `data:application/pdf;base64,${b64}`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Você está analisando um PDF escaneado de comprovante. Extraia os campos: fornecedor, cnpj, data, valor, descricao e texto_completo. Retorne apenas JSON.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Extraia os dados deste PDF:" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  let texto = resp.choices[0].message.content;
  texto = texto.replace(/```json/gi, "").replace(/```/g, "");

  try {
    return JSON.parse(texto);
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
//  ENVIAR PARA SIGO OBRAS (Mocha)
// ============================================================================
async function enviarDadosParaMocha(data) {
  const resp = await fetch(MOCHA_OCR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  const resultado = await resp.json().catch(() => ({}));
  console.log("[MOCHA][RESP]", resultado);

  return resultado;
}

// ============================================================================
//  ROTAS HONO
// ============================================================================
const app = new Hono();

app.get("/", (c) => c.text("BOT OK"));

app.get("/webhook/whatsapp", (c) => {
  if (
    c.req.query("hub.mode") === "subscribe" &&
    c.req.query("hub.verify_token") === VERIFY_TOKEN_META
  ) {
    return c.text(c.req.query("hub.challenge"));
  }
  return c.text("Erro", 400);
});

// ============================================================================
//  RECEBIMENTO DE MENSAGENS DO WHATSAPP
// ============================================================================
app.post("/webhook/whatsapp", async (c) => {
  const body = await c.req.json();
  const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (!msg) {
    console.log("[WEBHOOK] Nenhuma mensagem encontrada.");
    return c.json({ status: "ignored" });
  }

  const from = msg.from;
  const type = msg.type;

  // CONFIRMAÇÃO “SIM”
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

      await enviarDadosParaMocha(pendente);
      await enviarMensagemWhatsApp(
        from,
        "Lançamento enviado ao SIGO Obras com sucesso! ✅"
      );

      delete ocrPendentes[from];
      return c.json({ status: "ok" });
    }

    await enviarMensagemWhatsApp(from, "Recebido!");
    return c.json({ status: "ok" });
  }

  // ARQUIVO (IMAGEM OU PDF)
  if (type === "image" || type === "document") {
    const mediaId = type === "image" ? msg.image.id : msg.document.id;
    const mime = type === "image" ? msg.image.mime_type : msg.document.mime_type;

    const midia = await baixarMidia(mediaId);

    let dados = {};

    if (mime.startsWith("image/")) {
      dados = await processarImagem(midia.buffer, mime);
    } else if (mime === "application/pdf") {
      dados = await processarPdf(midia.buffer);
    }

    // Guardar até o usuário confirmar
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

  await enviarMensagemWhatsApp(from, "Envie texto, imagem ou PDF.");
  return c.json({ status: "ok" });
});

// ============================================================================
//  SERVIDOR
// ============================================================================
serve({ fetch: app.fetch, port: PORT });
console.log(`🚀 BOT WHATSAPP RODANDO NA PORTA ${PORT}`);
