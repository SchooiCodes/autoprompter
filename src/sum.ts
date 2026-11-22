/** Return the sum of two numbers. */
export function sum(a: number, b: number): number {
  // TypeScript types are erased at runtime and `+` concatenates strings in
  // JavaScript, so guard to avoid silently returning a joined-up string.
  if (typeof a !== "number" || typeof b !== "number") {
    throw new TypeError("sum expects two numbers")
  }
  return a + b
}
