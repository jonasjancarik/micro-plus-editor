// The page looks elements up by selector and knows what they are. Typing each one comes with the move to React.
interface Element {
  dataset: DOMStringMap;
  hidden: boolean;
  style: CSSStyleDeclaration;
  disabled: boolean;
  focus(options?: FocusOptions): void;
  blur(): void;
}
interface EventTarget {
  closest?(selector: string): Element | null;
}
