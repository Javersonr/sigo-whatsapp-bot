// index.mjs

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import dotenv from 'dotenv'
import OpenAI from 'openai'

dotenv.config()

// ---------------------------------------------------------
// 🔹 Constantes e Variáveis de Ambiente
// ---------------------------------------------------------

const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0'

const VERIFY_TOKEN_META = process.env.VERIFY_TOKEN_META || 'sinergia123'
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || ''
const PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID || ''
const MOCHA_OCR_URL = process.env.MOCHA_OCR_URL || ''
const PORT = Number(process.env.PORT || 3000)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''

const openaiClient = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null

// ---------------------------------------------------------
// 🔹 LOG das variáveis de ambiente
// ---------------------------------------------------------
console.log("=== VARIÁVEIS DE AMBIENTE ===")
console.log("VERIFY_TOKEN_META:", VERIFY_TOKEN_META ? "OK" : "FALTANDO")
console.log("WHATSAPP_TOKEN:", WHATSAPP_TOKEN ? "OK" : "FALTANDO")
console.log("PHONE_NUMBER_ID:", PHONE_NUMBER_ID || "FALTANDO")
console.log("MOCHA_OCR_URL:", MOCHA_OCR_URL || "FALTANDO")
console.log("OPENAI_API_KEY:", OPENAI_API_KEY ? "OK" : "FALTANDO")
console.log("==============================")

// ---------------------------------------------------------
// 🔹 App Hono
// ---------------------------------------------------------
const app = new Hono()

// 🔹 Memória de OCR pendente por usuário
const ocrPendentes = globalThis.ocrPendentes || (globalThis.ocrPendentes = {})

// ---------------------------------------------------------
// 🔹 Enviar mensagem de texto no WhatsApp
// ---------------------------------------------------------
async function enviarMensagemWhatsApp(to, body) {
  const url = `${GRAPH_API_BASE}/${PHONE_NUMBER_ID}/messages`

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body }
  }

  console.log("[WhatsApp][REQUEST]", payload)

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  const json = await resp.json().catch(() => ({}))

  console.log("[WhatsApp][STATUS]", resp.status)
  console.log("[WhatsApp][RESPONSE]", json)

  return json
}

// ---------------------------------------------------------
// 🔹 Buscar info da mídia no WhatsApp
// ---------------------------------------------------------
async function buscarInfoMidiaWhatsApp(mediaId) {
  const url = `${GRAPH_API_BASE}/${mediaId}`

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`
    }
  })

  const json = await resp.json()
  console.log("[WhatsApp][MEDIA INFO][RESPONSE]", json)

  return json
}

// ---------------------------------------------------------
// 🔹 Baixar o arquivo binário da mídia
// ---------------------------------------------------------
async function baixarMidiaWhatsApp(mediaId) {
  const info = await buscarInfoMidiaWhatsApp(mediaId)

  const resp = await fetch(info.url, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`
    }
  })

  const buffer = Buffer.from(await resp.arrayBuffer())

  return {
    buffer,
    mimeType: info.mime_type,
    fileUrl: info.url
  }
}

// ---------------------------------------------------------
// 🔹 Extrair JSON OpenAI
// ---------------------------------------------------------
function extrairJson(content) {
  if (Array.isArray(content)) {
    content = content.map(c => c.text || "").join("\n")
  }

  let match = content.match(/\{[\s\S]*\}/)
  return JSON.parse(match ? match[0] : content)
}

// ---------------------------------------------------------
// 🔹 OCR IMAGEM via GPT-4o
// ---------------------------------------------------------
async function processarImagem(buffer, mimeType) {
  console.log("[OCR] Processando IMAGEM via GPT-4o...")

  const base64 = buffer.toString("base64")
  const dataUrl = `data:${mimeType};base64,${base64}`

  const resp = await openaiClient.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Extraia fornecedor, cnpj, valor, data, descricao, texto_completo. Retorne apenas JSON válido."
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Extraia os dados:" },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }
    ]
  })

  console.log("[OCR IMAGEM RAW]", resp.choices[0].message)

  try {
    return extrairJson(resp.choices[0].message.content)
  } catch (e) {
    console.error("[OCR IMAGEM] Erro:", e)
    return {
      fornecedor: "",
      cnpj: "",
      valor: "",
      data: "",
      descricao: "",
      texto_completo: resp.choices[0].message.content
    }
  }
}

// ---------------------------------------------------------
// 🔹 OCR PDF via GPT-4o (SEM pdf-parse!!!)
// ---------------------------------------------------------
async function processarPdf(buffer) {
  console.log("[OCR PDF] Processando PDF via GPT-4o...")

  const resp = await openaiClient.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Você é um extrator de PDFs. Retorne JSON: fornecedor, cnpj, valor, data, descricao, texto_completo."
      },
      {
        role: "user",
        content: "Extraia os dados do PDF enviado."
      }
    ],
    files: [{
      name: "documento.pdf",
      mime_type: "application/pdf",
      data: buffer
    }]
  })

  console.log("[OCR PDF RAW]", resp.choices[0].message)

  try {
    return extrairJson(resp.choices[0].message.content)
  } catch {
    return {
      fornecedor: "",
      cnpj: "",
      valor: "",
      data: "",
      descricao: "",
      texto_completo: resp.choices[0].message.content
    }
  }
}

// ---------------------------------------------------------
// 🔹 Enviar para Mocha (após SIM)
// ---------------------------------------------------------
async function enviarDadosParaMochaOCR(payload) {
  console.log("[MOCHA OCR][REQUEST]", payload)

  const resp = await fetch(MOCHA_OCR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })

  const json = await resp.json().catch(() => ({}))

  console.log("[MOCHA OCR][RESPONSE]", json)

  return json
}

// ---------------------------------------------------------
// 🔹 Webhook GET
// ---------------------------------------------------------
app.get("/webhook/whatsapp", (c) => {
  const mode = c.req.query("hub.mode")
  const token = c.req.query("hub.verify_token")
  const challenge = c.req.query("hub.challenge")

  if (mode === "subscribe" && token === VERIFY_TOKEN_META)
    return c.text(challenge)

  return c.text("Erro validação webhook", 403)
})

// ---------------------------------------------------------
// 🔹 Webhook POST – processamento das mensagens
// ---------------------------------------------------------
app.post("/webhook/whatsapp", async (c) => {
  const body = await c.req.json().catch(() => ({}))

  console.log("[Webhook POST] BODY:", JSON.stringify(body, null, 2))

  const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
  if (!msg) return c.json({ status: "ignored" })

  const from = msg.from
  const type = msg.type

  // -----------------------------------------------------
  // 🟦 Fluxo SIM
  // -----------------------------------------------------
  if (type === "text" && msg.text?.body.trim().toUpperCase() === "SIM") {
    const pend = ocrPendentes[from]
    if (!pend) {
      await enviarMensagemWhatsApp(from, "Nenhum comprovante pendente.")
      return c.json({ status: "ok" })
    }

    try {
      await enviarDadosParaMochaOCR(pend)
      await enviarMensagemWhatsApp(from, "Lançamento enviado ao SIGO Obras com sucesso! ✅")
      delete ocrPendentes[from]
    } catch {
      await enviarMensagemWhatsApp(from, "Erro ao enviar para o SIGO Obras.")
    }

    return c.json({ status: "ok" })
  }

  // -----------------------------------------------------
  // 🟨 TEXTO NORMAL
  // -----------------------------------------------------
  if (type === "text") {
    await enviarMensagemWhatsApp(from, "Recebido!")
    return c.json({ status: "ok" })
  }

  // -----------------------------------------------------
  // 🟧 DOCUMENTO/IMAGEM
  // -----------------------------------------------------
  if (type === "document" || type === "image") {
    const mediaId = type === "image" ? msg.image.id : msg.document.id
    const mime = type === "image" ? msg.image.mime_type : msg.document.mime_type

    const { buffer, fileUrl } = await baixarMidiaWhatsApp(mediaId)

    let dados = {}

    if (mime.startsWith("image/"))
      dados = await processarImagem(buffer, mime)
    else if (mime === "application/pdf")
      dados = await processarPdf(buffer)
    else {
      await enviarMensagemWhatsApp(from, "Tipo de arquivo não suportado.")
      return c.json({ status: "ok" })
    }

    // Guardar pendente
    ocrPendentes[from] = {
      userPhone: from,
      fileUrl,
      fornecedor: dados.fornecedor || "",
      cnpj: dados.cnpj || "",
      valor: dados.valor || "",
      data: dados.data || "",
      descricao: dados.descricao || "",
      texto_ocr: dados.texto_completo || ""
    }

    await enviarMensagemWhatsApp(
      from,
      `Recebi o seu comprovante ✅\n\n` +
      `Fornecedor: ${dados.fornecedor || 'N/D'}\n` +
      `CNPJ: ${dados.cnpj || 'N/D'}\n` +
      `Data: ${dados.data || 'N/D'}\n` +
      `Valor: ${dados.valor || 'N/D'}\n` +
      `Descrição: ${dados.descricao || 'N/D'}\n\n` +
      `Se estiver correto, responda *SIM* para lançar no financeiro.`
    )

    return c.json({ status: "ok" })
  }

  return c.json({ status: "ok" })
})

// ---------------------------------------------------------
// 🔹 Start Server
// ---------------------------------------------------------
serve({
  fetch: app.fetch,
  port: PORT
})

console.log(`🚀 SIGO WHATSAPP BOT rodando na porta ${PORT}`)
