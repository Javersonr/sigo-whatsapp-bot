import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import FormData from 'form-data';

dotenv.config();

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";

const VERIFY_TOKEN_META = process.env.VERIFY_TOKEN_META;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const META_PHONE_ID = process.env.META_PHONE_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MOCHA_OCR_URL = process.env.MOCHA_OCR_URL;

const PORT = Number(process.env.PORT || 3000);

if (!VERIFY_TOKEN_META || !WHATSAPP_TOKEN || !META_PHONE_ID || !OPENAI_API_KEY || !MOCHA_OCR_URL) {
  console.error("[ERRO] Variáveis essenciais faltando.");
}

const app = new Hono();

/* =====================================================
   FUNÇÃO ENVIO WHATSAPP
=====================================================*/
async function enviarWhatsAppTexto(para, texto) {
  try {
    const res = await fetch(`${GRAPH_API_BASE}/${META_PHONE_ID}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: para,
        type: "text",
        text: { body: texto }
      })
    });

    const data = await res.json();
    console.log("[WhatsApp][RESPONSE BODY]", data);
  } catch (e) {
    console.error("[WhatsApp ERRO]", e);
  }
}

/* =====================================================
   FUNÇÃO PARA PEGAR O ARQUIVO DO WHATSAPP
=====================================================*/
async function baixarArquivo(mediaId) {
  try {
    const urlReq = await fetch(`${GRAPH_API_BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
    const urlJson = await urlReq.json();

    const arquivoReq = await fetch(urlJson.url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });

    const buffer = await arquivoReq.arrayBuffer();

    return {
      buffer,
      url_download: urlJson.url
    };
  } catch (e) {
    console.error("[ERRO AO BAIXAR ARQUIVO]", e);
    return null;
  }
}

/* =====================================================
   FUNÇÃO OCR OPENAI (imagem + PDF)
=====================================================*/
async function processarOCR(buffer, mimeType) {
  try {
    const isImage = mimeType.includes("image");
    const isPdf = mimeType.includes("pdf");

    const base64Data = Buffer.from(buffer).toString("base64");

    let messages = [];

    const systemPrompt = `
Extraia os seguintes dados e retorne APENAS um JSON válido:
{
 "fornecedor":"",
 "cnpj":"",
 "valor":"",
 "data":"",
 "descricao":""
}
`;

    if (isImage) {
      messages = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: "Extraia os dados da imagem:" },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64Data}` }
            }
          ]
        }
      ];
    }

    if (isPdf) {
      messages = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: "Extraia os dados deste PDF:" },
            {
              type: "file",
              file: { data: base64Data, mime_type: mimeType }
            }
          ]
        }
      ];
    }

    const req = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        max_output_tokens: 500,
        response_format: { type: "json_object" }
      })
    });

    const json = await req.json();
    console.log("[OCR IMAGEM][RAW MESSAGE]", json.output[0]);

    let parsed = {};
    try {
      parsed = JSON.parse(json.output[0].content);
    } catch {
      parsed = {};
    }

    return parsed;

  } catch (e) {
    console.error("[ERRO OCR]", e);
    return {};
  }
}

/* =====================================================
   FUNÇÃO PARA ENVIAR AO MOCHA
=====================================================*/
async function enviarMocha(ocrData, userPhone, fileUrl) {
  try {
    const body = {
      user_phone: userPhone,
      file_url: fileUrl,
      fornecedor: ocrData.fornecedor || "",
      cnpj: ocrData.cnpj || "",
      valor: ocrData.valor || "",
      data: ocrData.data || "",
      descricao: ocrData.descricao || "",
      texto_ocr: JSON.stringify(ocrData)
    };

    console.log("[MOCHA OCR][REQUEST]", JSON.stringify(body, null, 2));

    const req = await fetch(MOCHA_OCR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const responseData = await req.json();
    console.log("[MOCHA OCR][STATUS]", req.status);
    console.log("[MOCHA OCR][RESPONSE]", responseData);

    if (!req.ok) throw new Error("Erro ao enviar dados OCR para Mocha: " + req.status);

    return true;
  } catch (e) {
    console.error("[MOCHA OCR] Falha ao enviar dados para SIGO Obras:", e);
    return false;
  }
}

/* =====================================================
   WEBHOOK (RECEPÇÃO)
=====================================================*/
app.get("/webhook/whatsapp", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  if (mode && token === VERIFY_TOKEN_META) {
    return c.text(challenge);
  }

  return c.text("Erro de verificação", 403);
});

let memoria = {}; // para guardar OCR até confirmar SIM

app.post("/webhook/whatsapp", async (c) => {
  const body = await c.req.json();
  console.log("[Webhook POST] BODY RECEBIDO:", JSON.stringify(body, null, 2));

  const entry = body.entry?.[0]?.changes?.[0]?.value;
  if (!entry?.messages) return c.text("ok");

  const msg = entry.messages[0];
  const telefone = msg.from;

  /* =====================================================
     USUÁRIO RESPONDEU "SIM"
  =====================================================*/
  if (msg.type === "text" && msg.text.body.trim().toLowerCase() === "sim") {
    if (!memoria[telefone]) {
      await enviarWhatsAppTexto(telefone, "Nenhum lançamento pendente.");
      return c.json({ ok: true });
    }

    const data = memoria[telefone];
    const ok = await enviarMocha(data.ocr, telefone, data.fileUrl);

    delete memoria[telefone];

    if (ok)
      await enviarWhatsAppTexto(telefone, "Perfeito! ✅\nO lançamento já foi enviado para o SIGO Obras.");
    else
      await enviarWhatsAppTexto(telefone, "⚠ Ocorreu um erro ao enviar ao SIGO Obras.");

    return c.json({ ok: true });
  }

  /* =====================================================
     RECEBEU ARQUIVO (imagem ou PDF)
  =====================================================*/
  if (msg.type === "image" || msg.type === "document") {
    const media = msg.image || msg.document;
    const mediaId = media.id;
    const filename = media.filename || "arquivo";
    const mimeType = media.mime_type || "application/octet-stream";

    console.log(`[Arquivo recebido de ${telefone}] mediaId=${mediaId}, filename=${filename}`);

    const fileData = await baixarArquivo(mediaId);
    if (!fileData) {
      await enviarWhatsAppTexto(telefone, "Erro ao baixar o arquivo.");
      return c.json({ ok: false });
    }

    const ocr = await processarOCR(fileData.buffer, mimeType);

    memoria[telefone] = {
      ocr,
      fileUrl: fileData.url_download
    };

    await enviarWhatsAppTexto(
      telefone,
      `Recebi o seu comprovante ✅

Fornecedor: ${ocr.fornecedor}
CNPJ: ${ocr.cnpj}
Data: ${ocr.data}
Valor: R$ ${ocr.valor}
Descrição: ${ocr.descricao}

Se estiver correto, responda *SIM* para lançar no financeiro.`
    );

    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});

/* =====================================================
   INICIAR SERVIDOR
=====================================================*/
serve({ fetch: app.fetch, port: PORT });
console.log(`🚀 SIGO WHATSAPP BOT rodando na porta ${PORT}`);

export default app;
