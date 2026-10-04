/** Hands `data` to the browser as a file to save. */
export const downloadFile = (data: BlobPart, filename: string, type: string) => {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
