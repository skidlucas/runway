import { describe, expect, it } from "vitest"
import { fileOrderStamps, orderStamps } from "~/lib/import-bundle"
import { applyCsvMapping, guessCsvMapping, parseCsvText, parseOfx, parseQif } from "~/lib/importers/bank"

describe("CSV", () => {
  it("detects a French bank export with debit/credit columns", () => {
    const text = `﻿Date;Libellé;Débit;Crédit
02/10/2026;CB MONOPRIX PARIS;42,18;
01/10/2026;VIR SALAIRE;;2 840,00
30/09/2026;CB "LE COMPTOIR";38,50;`
    const rows = parseCsvText(text)
    const { mapping } = guessCsvMapping(rows)
    expect(mapping).toMatchObject({ date: 0, payee: 1, amount: null, debit: 2, credit: 3, hasHeader: true, dateFormat: "dmy" })
    const { transactions, errors } = applyCsvMapping(rows, mapping)
    expect(errors).toBe(0)
    expect(transactions).toEqual([
      { date: "2026-10-02", amount: -4218, payee: "CB MONOPRIX PARIS", notes: null, importedId: null },
      { date: "2026-10-01", amount: 284000, payee: "VIR SALAIRE", notes: null, importedId: null },
      { date: "2026-09-30", amount: -3850, payee: 'CB "LE COMPTOIR"', notes: null, importedId: null },
    ])
  })

  it("handles a signed amount column and ISO dates", () => {
    const rows = parseCsvText("date,description,amount,memo\n2026-10-02,Netflix,-13.49,abonnement\n2026-10-03,Refund,5.00,")
    const { mapping } = guessCsvMapping(rows)
    const { transactions } = applyCsvMapping(rows, mapping)
    expect(transactions.map((t) => [t.date, t.amount, t.payee, t.notes])).toEqual([
      ["2026-10-02", -1349, "Netflix", "abonnement"],
      ["2026-10-03", 500, "Refund", null],
    ])
  })
})

describe("OFX", () => {
  it("reads SGML statements", () => {
    const text = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261002120000<TRNAMT>-42.18<FITID>A1<NAME>MONOPRIX &amp; CO<MEMO>CB 01/10
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261001<TRNAMT>2840.00<FITID>A2<NAME>SALAIRE
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>2026<TRNAMT>-1.00<FITID>A3<NAME>ILLISIBLE
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
    expect(parseOfx(text)).toEqual({
      transactions: [
        { date: "2026-10-02", amount: -4218, payee: "MONOPRIX & CO", notes: "CB 01/10", importedId: "A1" },
        { date: "2026-10-01", amount: 284000, payee: "SALAIRE", notes: null, importedId: "A2" },
      ],
      errors: 1,
    })
  })
})

describe("QIF", () => {
  it("reads records", () => {
    const text = `!Type:Bank
D02/10/2026
T-42.18
PMonoprix
MCourses
^
D25/09/2026
T1,250.00
PSalaire
^`
    expect(parseQif(text)).toEqual({
      transactions: [
        { date: "2026-10-02", amount: -4218, payee: "Monoprix", notes: "Courses", importedId: null },
        { date: "2026-09-25", amount: 125000, payee: "Salaire", notes: null, importedId: null },
      ],
      errors: 0,
    })
  })

  it("reads Quicken dates and counts the records it cannot read", () => {
    const text = `!Type:Bank
D12/ 5'98
T-10.00
PVieux
^
D 3/ 4/26
T-20.00
PRécent
^
D31/02/2026
T-5.00
PImpossible
^`
    const { transactions, errors } = parseQif(text)
    expect(transactions.map((t) => [t.date, t.payee])).toEqual([
      ["1998-05-12", "Vieux"],
      ["2026-04-03", "Récent"],
    ])
    expect(errors).toBe(1)
  })
})

describe("order of a day", () => {
  it("stamps the highest rank last, ties in input order", () => {
    const stamps = orderStamps([5, 1, 5, 3], Date.UTC(2026, 9, 3))
    expect(stamps).toEqual([
      "2026-10-02T23:59:59.998Z",
      "2026-10-02T23:59:59.996Z",
      "2026-10-02T23:59:59.999Z",
      "2026-10-02T23:59:59.997Z",
    ])
  })

  it("puts the first row of a newest-first file on top of its day", () => {
    const stamps = fileOrderStamps(["2026-10-02", "2026-10-02", "2026-10-01"])
    expect(stamps[0]! > stamps[1]!).toBe(true)
  })

  it("puts the last row of an oldest-first file on top of its day", () => {
    const stamps = fileOrderStamps(["2026-10-01", "2026-10-02", "2026-10-02"])
    expect(stamps[2]! > stamps[1]!).toBe(true)
  })

  it("reads the direction from the first change of day when the file starts and ends on the same day", () => {
    const stamps = fileOrderStamps(["2026-10-02", "2026-10-01", "2026-10-01", "2026-10-02"])
    expect(stamps[1]! > stamps[2]!).toBe(true)
  })

  it("takes a single-day file as newest first", () => {
    const stamps = fileOrderStamps(["2026-10-02", "2026-10-02"])
    expect(stamps[0]! > stamps[1]!).toBe(true)
  })
})
