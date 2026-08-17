// Ambient declarations for asset imports that Vite's bundler resolves to URLs at build time.
// Lets `import icon from "./assets/rail/file.png"` typecheck without pulling vite/client.
declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.jpg" {
  const src: string;
  export default src;
}
declare module "*.svg" {
  const src: string;
  export default src;
}
