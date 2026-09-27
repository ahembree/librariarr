// The prebuilt ES bundle: the same `SwaggerUIBundle` the package's typings
// describe, as a default export. Used instead of swagger-ui-react, whose ESM
// breaks under the bundler ("refract is not a function" on expanding an
// operation); this bundle is self-contained.
declare module "swagger-ui-dist/swagger-ui-es-bundle.js" {
  import type { SwaggerUIBundle } from "swagger-ui-dist";
  const bundle: SwaggerUIBundle;
  export default bundle;
}
