/** Vitest bundles these with `?raw`. Typecheck does not. */
declare module "*.svg?raw" {
  const content: string;
  export default content;
}

declare module "*.md?raw" {
  const content: string;
  export default content;
}
