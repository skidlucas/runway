import { describe, expect, it } from "vitest"
import { csvNumber, csvText } from "~/lib/csv-export"

describe("CSV export cells", () => {
  it("keeps text that a spreadsheet would run as a formula as text", () => {
    expect(csvText('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`)
    expect(csvText("+33 6 12")).toBe("'+33 6 12")
    expect(csvText("-remboursement")).toBe("'-remboursement")
    expect(csvText("@SUM(A1)")).toBe("'@SUM(A1)")
    expect(csvText("\tcmd")).toBe("'\tcmd")
    expect(csvText("\rcmd")).toBe(`"'\rcmd"`)
  })

  it("quotes separators, quotes and line breaks", () => {
    expect(csvText("Café; bar")).toBe(`"Café; bar"`)
    expect(csvText("a\nb")).toBe(`"a\nb"`)
    expect(csvText("a\rb")).toBe(`"a\rb"`)
    expect(csvText(null)).toBe("")
    expect(csvText("Boulangerie")).toBe("Boulangerie")
  })

  it("leaves amounts as numbers", () => {
    expect(csvNumber("-12,34")).toBe("-12,34")
    expect(csvNumber("1 200,00")).toBe("1 200,00")
  })
})
