import type { Check } from "./contracts.js";

// Evaluated in Chrome. Keep this function self-contained and never mutate page state.
export function readElement(e: Element | null, spec: { kind: string; value?: string | undefined; attribute?: string | undefined }): { actual: string; error?: string; available?: boolean } {
  if (!e) return { actual: "<0 matching elements>", available: false };
  const html = e as HTMLElement;
  const sensitive = e.matches('input[type=password], input[type=file], [autocomplete="one-time-code"]');
  const rect = e.getBoundingClientRect();
  const visible = !!rect.width && !!rect.height && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  if (spec.kind === "visible") return { actual: String(visible) };
  if (!visible) return { actual: "<not visible>", available: false };
  if (spec.kind === "text") return { actual: html.innerText || "" };
  if (spec.kind === "value") {
    if (sensitive) return { actual: "", error: "Sensitive control values cannot be collected." };
    if (!("value" in e)) return { actual: "", error: "Target is not a value control." };
    return { actual: String((e as HTMLInputElement).value) };
  }
  if (spec.kind === "checked") {
    if (typeof (e as HTMLInputElement).checked !== "boolean") return { actual: "", error: "Target is not a checkable control." };
    return { actual: String((e as HTMLInputElement).checked) };
  }
  if (spec.kind === "attribute") {
    if (sensitive || /^(value|srcdoc|on)/i.test(spec.attribute ?? "")) return { actual: "", error: "Sensitive attribute cannot be collected." };
    return { actual: e.getAttribute(spec.attribute ?? "") ?? "" };
  }
  return { actual: "", error: "Unsupported check kind." };
}
export function legacyExpression(checks: readonly Check[]): string {
  return `(checks => checks.map(c => {
    const base={kind:c.kind,expected:c.value,actual:'',passed:false,method:'dom',...(c.id?{id:c.id}:{})};
    if(c.shadow==='closed' || c.frames?.length || c.shadow==='open') return {...base,error:'Scope requires the scoped verifier'};
    if(c.kind==='url') return {...base,actual:location.href,passed:location.href===c.value};
    let nodes;try{nodes=c.selector?[...document.querySelectorAll(c.selector)]:[document.body]}catch{return {...base,error:'Invalid CSS selector'}}
    let result;
    if(c.kind==='count') result={actual:String(nodes.length)};
    else if(c.kind==='visible' && nodes.length===0) result={actual:'false'};
    else if(nodes.length!==1) result={actual:'<'+nodes.length+' matching elements>',available:false};
    else result=(${readElement.toString()})(nodes[0],c);
    const passed=c.kind==='text'?result.actual.includes(c.value):result.actual===c.value;
    return {...base,...result,actual:result.actual.slice(0,2048),passed:!result.error&&result.available!==false&&passed};
  }))(${JSON.stringify(checks)})`;
}

// Focused, live observation for the coding agent. No opaque JS/application stores.
export function readPage(region: Element, options: { limit: number; shadow?: string | undefined }) {
  const elements: Element[] = [region]; const seen = new Set<Element>(); const controls: Record<string, unknown>[] = []; const frames: Record<string, unknown>[] = [];
  for (let index = 0; index < elements.length; index++) {
    const e = elements[index]!; if (seen.has(e)) continue; seen.add(e);
    for (const child of e.children) elements.push(child);
    if (options.shadow === "open" && e.shadowRoot) for (const child of e.shadowRoot.children) elements.push(child);
    const visible = e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !!e.getBoundingClientRect().width;
    if (!visible) continue;
    const selector = e.id ? `#${CSS.escape(e.id)}` : e.getAttribute("name") ? `${e.tagName.toLowerCase()}[name=${JSON.stringify(e.getAttribute("name"))}]` : null;
    if (e.matches("iframe,frame")) frames.push({ selector, title: e.getAttribute("title"), src: e.getAttribute("src") });
    if (!e.matches('input,textarea,select,button,a,[role=button],[contenteditable=true]')) continue;
    const sensitive = e.matches('input[type=password],input[type=file],[autocomplete="one-time-code"]');
    const label = e.getAttribute("aria-label") || (e as HTMLInputElement).labels?.[0]?.textContent || (e as HTMLElement).innerText || e.getAttribute("placeholder") || "";
    controls.push({ tag: e.tagName.toLowerCase(), selector, label: label.slice(0, 240), role: e.getAttribute("role"),
      disabled: (e as HTMLInputElement).disabled === true, ...(sensitive ? { valueRedacted: true } : "value" in e ? { value: String(e.value).slice(0, 240) } : {}) });
    if (elements.length > 20_000) break;
  }
  const text = (region as HTMLElement).innerText || "";
  return { url: location.href, title: document.title, text: text.slice(0, 8_000), controls: controls.slice(0, options.limit), frames: frames.slice(0, 30),
    truncated: text.length > 8_000 || controls.length > options.limit || frames.length > 30 || elements.length > 20_000, observedAt: Date.now() };
}
