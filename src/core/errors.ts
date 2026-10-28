export class DeskError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeskError";
  }
}
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export function invariant(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new DeskError(code, message);
}
