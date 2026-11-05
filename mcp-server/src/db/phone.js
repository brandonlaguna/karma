// El Excel de origen trae saltos de línea y prefijos sueltos ("++57", "+57 3");
// se limpia lo seguro (formato) sin adivinar números.
export function normalizePhone(phone) {
  if (phone == null) return null;
  const cleaned = phone
    .replace(/\s*[\r\n]+\s*/g, " / ")
    .replace(/\s+/g, " ")
    .replace(/^\+\+/, "+")
    .trim();
  return cleaned || null;
}
