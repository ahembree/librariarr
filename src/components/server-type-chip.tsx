import { ColorChip } from "@/components/color-chip";
import { SERVER_TYPE_STYLES, DEFAULT_SERVER_STYLE } from "@/lib/server-styles";

export function ServerTypeChip({ type, className }: { type: string; className?: string }) {
  const style = SERVER_TYPE_STYLES[type] ?? DEFAULT_SERVER_STYLE;
  return <ColorChip className={`${style.classes}${className ? ` ${className}` : ""}`}>{style.label}</ColorChip>;
}
