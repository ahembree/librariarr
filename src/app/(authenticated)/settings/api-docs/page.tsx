"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, FileJson, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import "swagger-ui-dist/swagger-ui.css";
import "./swagger-dark.css";

const SPEC_URL = "/api/settings/api-keys/openapi";

/**
 * Interactive API reference: Swagger UI over the document the app generates
 * per request. The prebuilt `swagger-ui-dist` bundle is used rather than
 * `swagger-ui-react` — bundling that package's ESM breaks its parser
 * ("refract is not a function" the moment an operation is expanded) — and it
 * is bundled with the app, never a CDN, so an offline install has it too.
 * "Try it out" needs an API key pasted into Authorize: `/api/v1` never takes
 * the browser session, and nothing entered here is stored (`persistAuthorization`
 * off, so a key never lands in localStorage).
 */
export default function ApiDocsPage() {
  const mount = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const node = mount.current;
    if (!node) return;
    let cancelled = false;
    // Loaded in the effect: the bundle touches `window` on import.
    import("swagger-ui-dist/swagger-ui-es-bundle.js").then(({ default: SwaggerUI }) => {
      if (cancelled) return;
      SwaggerUI({
        url: SPEC_URL,
        domNode: node,
        docExpansion: "list",
        defaultModelsExpandDepth: -1,
        displayRequestDuration: true,
        persistAuthorization: false,
      });
      setLoading(false);
    });
    return () => {
      cancelled = true;
      node.replaceChildren();
    };
  }, []);

  return (
    <div className="api-docs space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">API Docs</h1>
          <p className="text-sm text-muted-foreground">
            The public <code className="font-mono text-[0.85em] rounded bg-muted/60 px-1 py-0.5">/api/v1</code> API,
            generated from this version. To try a request, click <strong>Authorize</strong> and paste an API key —
            the browser session does not apply here, and the key is not saved.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* A plain anchor: the settings tabs read the hash on mount, which a
              client-side navigation to the same route does not trigger. */}
          <Button variant="outline" size="sm" asChild>
            <a href="/settings#authentication">
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              API Keys
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={SPEC_URL} target="_blank" rel="noopener noreferrer">
              <FileJson className="mr-1.5 h-4 w-4" />
              Raw JSON
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={`${SPEC_URL}?download=1`} download="librariarr-openapi.json">
              <Download className="mr-1.5 h-4 w-4" />
              Download
            </a>
          </Button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
      <div ref={mount} />
    </div>
  );
}
