import { parseActual, unzipActual } from "./actual/parse"
import type { ImportBundle } from "./import-bundle"
import { type ParsedBankFile, parseCsvText, parseOfx, parseQif } from "./importers/bank"
import { backupToBundle, isRunwayBackup } from "./runway-backup"
import { loadSqlJs } from "./sqljs"

/** A file read and waiting for the user to confirm its import. A CSV keeps its raw rows until its columns are mapped. */
export type PendingImport =
  | { kind: "bundle"; fileName: string; bundle: ImportBundle }
  | { kind: "bank"; fileName: string; format: "csv" | "ofx" | "qif"; rows?: string[][]; parsed?: ParsedBankFile }

/** Reads a file by its extension; throws, with a message for the user, on a format runway does not import. */
export const readImportFile = async (file: File): Promise<PendingImport> => {
  const fileName = file.name
  const name = fileName.toLowerCase()
  if (name.endsWith(".zip")) {
    const SQL = await loadSqlJs()
    return { kind: "bundle", fileName, bundle: parseActual(SQL, unzipActual(new Uint8Array(await file.arrayBuffer()))) }
  }
  if (name.endsWith(".json")) {
    const json: unknown = JSON.parse(await file.text())
    if (!isRunwayBackup(json)) throw new Error("Ce fichier JSON n'est pas une sauvegarde Runway complète")
    return { kind: "bundle", fileName, bundle: backupToBundle(json) }
  }
  if (name.endsWith(".csv") || name.endsWith(".txt")) return { kind: "bank", fileName, format: "csv", rows: parseCsvText(await file.text()) }
  if (name.endsWith(".ofx") || name.endsWith(".qfx")) return { kind: "bank", fileName, format: "ofx", parsed: parseOfx(await file.text()) }
  if (name.endsWith(".qif")) return { kind: "bank", fileName, format: "qif", parsed: parseQif(await file.text()) }
  throw new Error("Format non pris en charge : .zip (Actual), .json, .csv, .ofx ou .qif")
}
