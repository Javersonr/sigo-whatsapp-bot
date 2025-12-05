import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import dotenv from 'dotenv'
import OpenAI from 'openai'
import pdfParse from 'pdf-parse'

dotenv.config()

// ------------------------------
// CONFIG META / OPENAI / MOCHA
// ------------------------------
const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0'
const VERIFY_TOKEN_META = process.env.VERIFY_TOKEN_META || 'sinergia123'
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || ''
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || ''
const OPENAI_KEY = process.env.OPENAI_API_KEY || ''
const MOCHA_OCR_URL = process.env.MOCHA_OCR_URL || ''
const PORT = Number(process.env.PORT || 3000)

const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null

// Memória temporária para confirmar com SIM
const memoriaOCR = new Map()

// --------------------------------------------------
// ENVIAR MENSAGEM WHATSAPP
// --------------------------------------------------
async function enviarMensagemWhatsApp(to, body) {
  const url = `${GRAPH_API_BASE}/${PHONE_NUMBER_ID}/messages`
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body }
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  })

  const json = await resp.json().catch(() => ({}))
  console.log("[WhatsApp][SEND RESULT]", resp.status, json)
  return resp.ok
}

// --------------------------------------------------
// BUSCAR METADADOS DE MÍDIA
// --------------------------------------------------
async function buscarInfoMidiaWhatsApp(mediaId) {
  const url = `${GRAPH_API_BASE}/${mediaId}`

  const resp = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
  })

  if (!resp.ok) throw new Error("Erro ao buscar info da mídia")
  return await resp.json()
}

// --------------------------------------------------
// BAIXAR ARQUIVO
// --------------------------------------------------
async function baixarMidiaWhatsApp(mediaId) {
  const info = await buscarInfoMidiaWhatsApp(mediaId)

  const fileResp = await fetch(info.url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
  })

  const buffer = Buffer.from(await fileResp.arrayBuffer())

  return {
    buffer,
    mimeType: info.mime_type,
    fileUrl: info.url
  }
}

// --------------------------------------------------
// OCR IMAGEM (GPT-4o mini)
// --------------------------------------------------
async function processarImagemComOCR(buffer, mime) {
  const b64 = buffer.toString("base64")
  const dataUrl = `data:${mime};base64,${b64}`

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Extraia: fornecedor, cnpj, valor, data, descricao. Retorne somente JSON válido."
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Extraia os dados da imagem:" },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }
    ]
  })

  let text = resp.choices[0].message.content
  try {
    const json = JSON.parse(text.match(/\{[\s\S]*\}/)[0])
    return json
  } catch {
    return {
      fornecedor: "",
      cnpj: "",
      valor: "",
      data: "",
      descricao: "",
      texto_completo: text
    }
  }
}

// --------------------------------------------------
// OCR PDF
// --------------------------------------------------
async function processarPdfComOCR(buffer) {
  let textoExtraido = ""

  try {
    const parsed = await pdfParse(buffer)
    textoExtraido = parsed.text?.trim() || ""
  } catch (e) {
    textoExtraido = ""
  }

  // PDF SEM TEXTO → usa Vision fallback
  if (!textoExtraido) {
    return {
      fornecedor: "",
      cnpj: "",
      valor: "",
      data: "",
      descricao: "",
      texto_completo: ""
    }
  }

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Você extrai dados de PDF OCR. Retorne somente JSON com fornecedor, cnpj, valor, data, descricao."
      },
      {
        role: "user",
        content: textoExtraido.slice(0, 15000)
      }
    ]
  })

  let text = resp.choices[0].message.content

  try {
    const json = JSON.parse(text.match(/\{[\s\S]*\}/)[0])
    return { ...json, texto_completo: textoExtraido }
  } catch {
    return {
      fornecedor: "",
      cnpj: "",
      valor: "",
      data: "",
      descricao: "",
      texto_completo: textoExtraido
    }
  }
}

// --------------------------------------------------
// ENVIAR AO MOCHA (somente após SIM)
// --------------------------------------------------
async function enviarParaMocha(dados) {
  const resp = await fetch(MOCHA_OCR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dados)
  })

  return resp.ok
}

// ----------------------------------------------
// SERVIDOR HONO SETUP
// ----------------------------------------------
const app = new Hono()

app.get("/", c => c.text("SIGO BOT OK"))

app.get("/webhook/whatsapp", (c) => {
  if (
    c.req.query("hub.mode") === "subscribe" &&
    c.req.query("hub.verify_token") === VERIFY_TOKEN_META
  ) {
    return c.text(c.req.query("hub.challenge") || "")
  }
  return c.text("Erro", 403)
})

// --------------------------
// RECEBER MENSAGENS
// --------------------------
app.post("/webhook/whatsapp", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]

  if (!msg) return c.json({ ok: true })

  const from = msg.from
  const type = msg.type

  // ----------------------------------------------------
  // RESPOSTA SIM
  // ----------------------------------------------------
  if (type === "text" && msg.text?.body?.trim().toUpperCase() === "SIM") {
    const dados = memoriaOCR.get(from)

    if (!dados) {
      await enviarMensagemWhatsApp(from, "Nenhum comprovante pendente.")
      return c.json({ ok: true })
    }

    await enviarMensagemWhatsApp(from, "Enviando para o SIGO Obras...")

    const enviado = await enviarParaMocha(dados)

    if (enviado) {
      await enviarMensagemWhatsApp(
        from,
        "Lançamento enviado com sucesso! 🎉"
      )
    } else {
      await enviarMensagemWhatsApp(
        from,
        "Erro ao enviar para o SIGO Obras ❌. Tente novamente."
      )
    }

    memoriaOCR.delete(from)
    return c.json({ ok: true })
  }

  // ----------------------------------------------------
  // DOCUMENTO / IMAGEM
  // ----------------------------------------------------
  if (type === "image" || type === "document") {
    let mediaId =
      type === "image" ? msg.image.id : msg.document.id
    let mime =
      type === "image" ? msg.image.mime_type : msg.document.mime_type

    const midia = await baixarMidiaWhatsApp(mediaId)

    let dadosExtract

    if (mime === "application/pdf") {
      dadosExtract = await processarPdfComOCR(midia.buffer)
    } else {
      dadosExtract = await processarImagemComOCR(midia.buffer, mime)
    }

    memoriaOCR.set(from, {
      user_phone: from,
      file_url: midia.fileUrl,
      ...dadosExtract
    })

    await enviarMensagemWhatsApp(
      from,
      `Dados identificados:\n\nFornecedor: ${dadosExtract.fornecedor || "N/D"}\nCNPJ: ${
        dadosExtract.cnpj || "N/D"
      }\nValor: ${dadosExtract.valor || "N/D"}\nData: ${
        dadosExtract.data || "N/D"
      }\nDescrição: ${
        dadosExtract.descricao || "N/D"
      }\n\nSe estiver correto, responda *SIM* para lançar.`
    )

    return c.json({ ok: true })
  }

  return c.json({ ok: true })
})

// ----------------------------------------------
// SUBIR SERVIDOR
// ----------------------------------------------
serve({
  fetch: app.fetch,
  port: PORT
})

console.log("🚀 SIGO WHATSAPP BOT rodando na porta " + PORT)
