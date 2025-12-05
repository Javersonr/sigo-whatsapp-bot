// ============================================================================
//  BOT WHATSAPP – OCR IMAGEM + PDF DIGITAL + PDF ESCANEADO
//  Envio para SIGO OBRAS (Mocha) – /api/ocr-receber-arquivo
//  Versão: 06/12/2025 (sem pdf-poppler, usando pdftoppm)
// ============================================================================

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import OpenAI from "openai";
import fetch from "node-fetch";
import { createRequire } from "module";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

dotenv.config();

// ============================================================================
//  DEPENDÊNCIAS COMMONJS (pdf-parse)
// ============================================================================
const require = createRequire(import.meta.url);

// pdf-parse retorna diretamente a função (CommonJS)
const pdfParse = require("pdf-parse");

const execFileAsync = promisify(execFile);

// ============================================================================
//  CONFIG
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

// memória temporária até o usuário confirmar com "SIM"
const ocrPendentes =
  globalThis.ocrPendentes || (globalThis.ocrPendentes = {});

// ============================================================================
//  CONVERTER PDF -> PNG (1ª PÁGINA) COM pdftoppm (poppler-utils)
// ============================================================================
async function converterPdfParaPngPrimeiraPagina(buffer) {
  const tmpDir = "/tmp"; // funciona bem no Railway
  const id = randomUUID();

  const inputPath = path.join(tmpDir, `ocr_${id}.pdf`);
  const outputPrefix = path.join(tmpDir, `ocr_${id}`);

  // 1) Grava o PDF em disco
  await fs.writeFile(inputPath, buffer);

  // 2) Converte 1ª página em PNG usando pdftoppm
  // Saída: <outputPrefix>-1.png
  await execFileAsync("pdftoppm", [
    "-png",
    "-f",
    "1",
    "-l",
    "1",
    inputPath,
    outputPrefix,
  ]);

  const pngPath = `${outputPrefix}-1.png`;
  const pngBuffer = await fs.readFile(pngPath);

  // 3) Limpa arquivos temporários
  await fs.unlink(inputPath).catch(() => {});
  await fs.unlink(pngPath).catch(() => {});

  return pngBuffer;
}



// ============================================================================
//  ENVIAR TEXTO NO WHATSAPP
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
//  OCR IMAGEM – OpenAI Vision (gpt-4o-mini)
// ============================================================================
async function processarImagem(buffer, mimeType) {
  if (!openai) {
    console.error("[OCR IMAGEM] OPENAI_API_KEY não configurada.");
    return {
      fornecedor: "",
      cnpj: "",
      valor: "",
      data: "",
      descricao: "",
      texto_completo: "",
    };
  }

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

  let texto = resp.choices?.[0]?.message?.content || "";
  texto = texto.replace(/```json/gi, "").replace(/```/g, "");

  try {
    return JSON.parse(texto);
  } catch {
    console.warn("[OCR IMAGEM] Falha ao parsear JSON, enviando texto bruto.");
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
//  OCR PDF (DIGITAL + ESCANEADO)
// ============================================================================
async function processarPdf(buffer) {
  console.log("[OCR PDF] Tentando extrair texto via pdf-parse...");

  let textoExtraido = "";

  try {
    const result = await pdfParse(buffer);
    textoExtraido = result.text || "";
  } catch (e) {
    console.log("[OCR PDF] Erro pdf-parse:", e.message);
  }

  const textoTratado = textoExtraido.replace(/\s+/g, "").trim();

  // ================================================================
  // CASO 1 – PDF DIGITAL (tem texto via pdf-parse)
  // ================================================================
  if (textoTratado && textoTratado.length > 20) {
    console.log("[OCR PDF] PDF digital detectado. Enviando TEXTO ao GPT...");

    if (!openai) {
      console.error("[OCR PDF] OPENAI_API_KEY não configurada.");
      return {
        fornecedor: "",
        cnpj: "",
        valor: "",
        data: "",
        descricao: "",
        texto_completo: textoExtraido,
      };
    }

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Analise o texto de comprovantes e retorne apenas JSON: fornecedor, cnpj, data, valor, descricao, texto_completo.",
        },
        {
          role: "user",
          content: textoExtraido.slice(0, 16000),
        },
      ],
    });

    let resposta = resp.choices?.[0]?.message?.content || "";
    resposta = resposta.replace(/```json/gi, "").replace(/```/g, "");

    try {
      const json = JSON.parse(resposta);
      json.texto_completo = textoExtraido;
      return json;
    } catch {
      console.warn("[OCR PDF] Falha ao parsear JSON de PDF digital.");
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

  // ================================================================
  // CASO 2 – PDF ESCANEADO (sem texto) → Converter 1ª página em PNG + Vision
  // ================================================================
  console.log(
    "[OCR PDF] Pouco ou nenhum texto. Assumindo PDF escaneado → OCR visual."
  );

  if (!openai) {
    console.error("[OCR PDF] OPENAI_API_KEY não configurada.");
    return {
      fornecedor: "",
      cnpj: "",
      valor: "",
      data: "",
      descricao: "",
      texto_completo: "",
    };
  }

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
            "Você está analisando a imagem da 1ª página de um comprovante escaneado. Extraia os campos: fornecedor, cnpj, data, valor, descricao e texto_completo. Responda SOMENTE em JSON.",
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

    let texto = resp.choices?.[0]?.message?.content || "";
    texto = texto.replace(/```json/gi, "").replace(/```/g, "");

    try {
      const json = JSON.parse(texto);
      json.texto_completo = texto;
      return json;
    } catch {
      console.warn("[OCR PDF] Falha ao parsear JSON de PDF escaneado.");
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
//  ENVIAR PARA SIGO OBRAS (Mocha)
// ============================================================================
async function enviarDadosParaMocha(pendente) {
  if (!MOCHA_OCR_URL) {
    console.error("[MOCHA] MOCHA_OCR_URL não configurada.");
    return { erro: "MOCHA_OCR_URL não configurada" };
  }

  const payload = {
    telefone: pendente.userPhone,
    arquivo_url: pendente.fileUrl,
    fornecedor: pendente.fornecedor || "",
    cnpj: pendente.cnpj || "",
    valor: pendente.valor || "",
    data: pendente.data || "",
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
//  WEBHOOK – RECEBIMENTO DE MENSAGENS WHATSAPP
// ============================================================================
app.post("/webhook/whatsapp", async (c) => {
  const body = await c.req.json().catch((e) => {
    console.error("[WEBHOOK] Erro ao parsear JSON:", e);
    return {};
  });

  const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (!msg) {
    console.log("[WEBHOOK] Nenhuma mensagem encontrada.");
    return c.json({ status: "ignored" });
  }

  const from = msg.from;
  const type = msg.type;

  // ============================================================
  //  CONFIRMAÇÃO "SIM"
  // ============================================================
  if (type === "text") {
    const texto = msg.text?.body?.trim().toUpperCase() || "";

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

  // ============================================================
  //  IMAGEM OU PDF
  // ============================================================
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
  await enviarMensagemWhatsApp(from, "Envie texto, imagem ou PDF.");
  return c.json({ status: "ok" });
});

// ============================================================================
//  SERVIDOR
// ============================================================================
serve({ fetch: app.fetch, port: PORT });
console.log(`🚀 BOT WHATSAPP RODANDO NA PORTA ${PORT}`);
