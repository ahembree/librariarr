declare module "*.svg" {
  const content: { src: string; height?: number; width?: number } | string;
  export default content;
}
