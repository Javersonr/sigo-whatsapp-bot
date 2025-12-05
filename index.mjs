import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import dotenv from 'dotenv'
import OpenAI from 'openai'
import PDFParser from 'pdf2json'

dotenv.config()

// =============== META WHATSAPP API ==================
const GRAPH_API_BASE = "https://graph.facebook.com/v19.0"

// =============== VARIÁVEIS DE AMBIENTE ===============
const VERIFY_TOKEN_META = process.env.VERIFY_TOKEN_META || "sinergia123"
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || ""
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || ""
const MOCHA_OCR_URL = process.env.MOCHA_OCR_URL || ""
const PORT = Number(process.env.PORT || 3000)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null

const app = new Hono()

// =====================================================
// 🔹 Extrair TEXTO de PDF usando PDF2JSON
// =====================================================
async function extrairTextoPDF(buffer) {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser()

    pdfParser.on("pdfParser_dataError", errData => reject(errData.parserError))
    pdfParser.on("pdfParser_dataReady", pdfData => {
      const text = pdfParser.getRawTextContent() || ""
      resolve(text)
    })

    pdfParser.parseBuffer(buffer)
  })
}

// =====================================================
// 🔹 Enviar mensagem WhatsApp
// =====================================================
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

  return await resp.json().catch(() => ({}))
}

// =====================================================
// 🔹 Buscar dados da mídia
// =====================================================
async function buscarInfoMidia(mediaId) {
  const resp = await fetch(`${GRAPH_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
  })

  if (!resp.ok) throw new Error("Erro ao buscar metadados da mídia")

  return await resp.json()
}

// =====================================================
// 🔹 Baixar arquivo da mídia
// =====================================================
async function baixarMidia(mediaId) {
  const meta = await buscarInfoMidia(mediaId)

  const resp = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
  })

  if (!resp.ok) throw new Error("Erro ao baixar mídia")

  return {
    buffer: Buffer.from(await resp.arrayBuffer()),
    mimeType: meta.mime_type,
    fileUrl: meta.url
  }
}

// =====================================================
// 🔹 OCR IMAGEM VIA OPENAI
// =====================================================
async function ocrImagem(buffer, mimeType) {
  if (!openai) return {}

  const base64 = buffer.toString("base64")

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "Extraia fornecedor, cnpj, valor, data, descricao e texto_completo em JSON válido."
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Extraia esse comprovante:" },
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${base64}` }
          }
        ]
      }
    ]
  })

  let content = resp.choices[0].message.content
  const match = content.match(/\{[\s\S]*\}/)

  try {
    return JSON.parse(match ? match[0] : content)
  } catch {
    return { texto_completo: content }
  }
}

// =====================================================
// 🔹 OCR PDF (extrai texto e manda para IA)
// =====================================================
async function ocrPdf(buffer) {
  if (!openai) return {}

  const texto = await extrairTextoPDF(buffer)

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "Extraia fornecedor, cnpj, valor, data, descricao e texto_completo em JSON válido."
      },
      {
        role: "user",
        content: texto
      }
    ]
  })

  let content = resp.choices[0].message.content
  const match = content.match(/\{[\s\S]*\}/)

  try {
    const json = JSON.parse(match ? match[0] : content)
    return { ...json, texto_completo: texto }
  } catch {
    return { texto_completo: texto }
  }
}

// =====================================================
// 🔹 WEBHOOK GET (Verificação)
// =====================================================
app.get("/webhook/whatsapp", (c) => {
  const mode = c.req.query("hub.mode")
  const token = c.req.query("hub.verify_token")
  const challenge = c.req.query("hub.challenge")

  if (mode === "subscribe" && token === VERIFY_TOKEN_META) {
    return c.text(challenge)
  }

  return c.text("Erro validação", 403)
})

// =====================================================
// 🔹 WEBHOOK POST (Mensagens)
// =====================================================
app.post("/webhook/whatsapp", async (c) => {
  const body = await c.req.json().catch(() => ({}))

  const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
  if (!msg) return c.json({ status: "ignored" })

  const from = msg.from
  const type = msg.type

  // ================= TEXTO ========================
  if (type === "text") {
    const texto = msg.text.body.trim().toUpperCase()

    // CONFIRMAÇÃO SIM
    if (texto === "SIM" && global.lastData?.[from]) {
      try {
        await fetch(MOCHA_OCR_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(global.lastData[from])
        })

        await enviarMensagemWhatsApp(
          from,
          "Lançamento enviado com sucesso! ✅"
        )
      } catch (e) {
        await enviarMensagemWhatsApp(from, "Erro ao enviar ao SIGO Obras.")
      }

      return c.json({ status: "ok" })
    }

    await enviarMensagemWhatsApp(from, `Recebido: ${msg.text.body}`)
    return c.json({ status: "ok" })
  }

  // ================ ARQUIVOS (PDF/IMAGEM) ======================
  if (type === "document" || type === "image") {
    try {
      const mediaId = type === "document" ? msg.document.id : msg.image.id
      const midia = await baixarMidia(mediaId)

      let dados = {}

      if (midia.mimeType === "application/pdf") {
        dados = await ocrPdf(midia.buffer)
      } else if (midia.mimeType.startsWith("image/")) {
        dados = await ocrImagem(midia.buffer, midia.mimeType)
      }

      global.lastData ??= {}
      global.lastData[from] = {
        user_phone: from,
        file_url: midia.fileUrl,
        ...dados
      }

      await enviarMensagemWhatsApp(
        from,
        `Verifique os dados extraídos:\nFornecedor: ${dados.fornecedor || "N/D"}\nCNPJ: ${dados.cnpj || "N/D"}\nValor: ${dados.valor || "N/D"}\nData: ${dados.data || "N/D"}\n\nSe estiver correto, responda *SIM* para lançar.`
      )

      return c.json({ status: "ok" })
    } catch (e) {
      console.error("[ERRO OCR]", e)
      await enviarMensagemWhatsApp(
        from,
        "Erro ao processar o arquivo. Envie outra imagem ou PDF."
      )
      return c.json({ status: "error" })
    }
  }

  return c.json({ status: "ok" })
})

// =====================================================
// 🔹 INICIAR SERVIDOR
// =====================================================
serve({ fetch: app.fetch, port: PORT })
console.log(`🚀 SIGO WHATSAPP BOT rodando na porta ${PORT}`)
