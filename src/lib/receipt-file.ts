import type { ReceiptFile } from "~/server/schemas"

export const RECEIPT_ACCEPT = "image/*,application/pdf"

// Both AI providers shrink larger images anyway; sending them bigger only costs upload time.
const MAX_SIDE = 1600
const MAX_PDF_BYTES = 5 * 1024 * 1024

export const isReceiptFile = (file: File) => file.type.startsWith("image/") || file.type === "application/pdf"

const base64Of = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = reader.result as string
      resolve(url.slice(url.indexOf(",") + 1))
    }
    reader.onerror = () => reject(new Error("Fichier illisible"))
    reader.readAsDataURL(blob)
  })

const shrinkImage = async (file: File) => {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("Image illisible")
  })
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Image illisible")
  // JPEG has no transparency: a transparent screenshot would otherwise turn black.
  context.fillStyle = "#fff"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85))
  if (!blob) throw new Error("Image illisible")
  return blob
}

/** Turns an image or a PDF into what `readReceipt` takes: images shrunk to JPEG, PDFs as they are. */
export async function prepareReceiptFile(file: File): Promise<typeof ReceiptFile.Type> {
  if (file.type === "application/pdf") {
    if (file.size > MAX_PDF_BYTES) throw new Error("PDF trop lourd (5 Mo maximum) : envoie plutôt une capture")
    return { mediaType: "application/pdf", data: await base64Of(file) }
  }
  if (file.type.startsWith("image/")) return { mediaType: "image/jpeg", data: await base64Of(await shrinkImage(file)) }
  throw new Error("Seules les images et les PDF peuvent être lus")
}
