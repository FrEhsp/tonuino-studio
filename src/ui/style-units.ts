import { options, type VNode } from 'preact';

/**
 * Preact 11 sets numeric style values as they are, so `{ width: 220 }` would be
 * ignored by the browser. This restores the familiar behaviour of adding "px"
 * to numbers, with the same list of unitless properties as preact/compat.
 */
const IS_NON_DIMENSIONAL = /^(-|f[lo].*[^se]$|g.{5,}[^ps]$|z|o[pr]|(W.{5})?[lL]i.*(t|mp)$|an|(bo|s).{4}Im|sca|m.{6}[ds]|ta|c.*[st]$|wido|ini)/;

const previous = options.vnode;
options.vnode = (vnode: VNode) => {
  const props = vnode.props as { style?: unknown } | null;
  if (typeof vnode.type === 'string' && props && props.style && typeof props.style === 'object') {
    let style = props.style as Record<string, unknown>;
    let cloned = false;
    for (const key in style) {
      if (typeof style[key] === 'number' && !IS_NON_DIMENSIONAL.test(key)) {
        if (!cloned) {
          style = { ...style };
          cloned = true;
        }
        style[key] = `${style[key]}px`;
      }
    }
    if (cloned) props.style = style;
  }
  previous?.(vnode);
};
