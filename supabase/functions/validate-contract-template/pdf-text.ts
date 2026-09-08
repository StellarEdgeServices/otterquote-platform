// validate-contract-template/pdf-text.ts — PDF text extraction shared by the
// validator and revalidate-contract-templates. Lifted from index.ts (gh-1315).
//
// Deno cannot spawn pdfjs web workers; importing the worker module sets
// globalThis.pdfjsWorker so the "fake worker" path works. Without this,
// EVERY validation failed 422 "Setting up fake worker failed" (E2E walk fix
// 2026-07-07 — no real contractor template could ever validate).
import * as pdfjsLib from "npm:pdfjs-dist@4.0.379/legacy/build/pdf.mjs";
import "npm:pdfjs-dist@4.0.379/legacy/build/pdf.worker.mjs";

export async function extractPdfText(pdfBytes: Uint8Array): Promise<string> {
  // Disable worker (Deno serverless can't spawn pdfjs workers)
  // @ts-ignore — runtime property
  pdfjsLib.GlobalWorkerOptions.workerSrc = "";
  // pdfjs DETACHES the buffer it is handed; hand it a copy so a caller that
  // still holds the bytes (archive-then-scan in the assisted path) keeps them.
  const loadingTask = pdfjsLib.getDocument({
    data: pdfBytes.slice(),
    isEvalSupported: false,
    disableFontFace: true,
  });
  const pdf = await loadingTask.promise;
  let fullText = "";
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    // deno-lint-ignore no-explicit-any
    const pageText = textContent.items.map((item: any) => item.str ?? "").join(" ");
    fullText += pageText + "\n";
  }
  return fullText;
}
