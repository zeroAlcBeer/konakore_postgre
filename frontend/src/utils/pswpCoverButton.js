// "Set as cover" in the PhotoSwipe toolbar; behaviour in docs/characters.md, UI.
import i18n from '../i18n';
import { getPostCharacters, setCharacterCover } from '../api';
import { tagManager } from './TagManager';
import { chineseName, coverAction } from './characters';

const FRAME = 'M7 8h18v16H7z M9 10v12h14V10z';
const PEAK = 'M10 21l4-5 3 3.5 2-2.5 3 4z';
const TOAST_MS = 2400;

/** Registers the button and its toast on an open lightbox; onCoverSet(name) runs after a successful pick. */
export function registerCoverButton(pswp, { onCoverSet }) {
  const charactersByPost = new Map(); // postId -> Promise<string[]>
  const charactersOf = (postId) => {
    if (!charactersByPost.has(postId)) {
      charactersByPost.set(postId, getPostCharacters(postId).catch(() => {
        charactersByPost.delete(postId);
        return [];
      }));
    }
    return charactersByPost.get(postId);
  };

  let toast;
  let toastTimer;
  const showToast = (message, kind) => {
    toast.textContent = message;
    toast.dataset.kind = kind;
    toast.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, TOAST_MS);
  };

  pswp.ui.registerElement({
    name: 'cover-toast',
    appendTo: 'root',
    isButton: false,
    onInit: (el) => {
      toast = el;
      el.setAttribute('role', 'status');
      el.style.cssText = `position:absolute; top:64px; left:50%; transform:translateX(-50%); z-index:10;
        padding:8px 16px; border-radius:8px; font:14px/1.4 -apple-system,"PingFang SC",sans-serif;
        color:#f1f1f5; background:rgba(28,29,33,.92); box-shadow:0 4px 16px rgba(0,0,0,.4);
        opacity:0; transition:opacity 200ms ease-out; pointer-events:none;`;
    },
  });

  pswp.ui.registerElement({
    name: 'cover-button',
    className: 'pswp__button--cover',
    order: 6,
    isButton: true,
    title: i18n.t('characters.setCover'),
    html: `<svg aria-hidden="true" class="pswp__icn" viewBox="0 0 32 32" width="32" height="32">
      <path d="${FRAME}" fill-rule="evenodd" class="pswp__icn-shadow"/><path d="${PEAK}" class="pswp__icn-shadow"/>
      <path d="${FRAME}" fill-rule="evenodd"/><path d="${PEAK}"/>
    </svg>`,
    onInit: (button) => {
      const refresh = async () => {
        button.style.display = 'none';
        const postId = pswp.currSlide?.data?.postId;
        if (!postId) return;
        const characters = await charactersOf(postId);
        if (pswp.currSlide?.data?.postId === postId && coverAction(characters).visible) button.style.display = '';
      };
      pswp.on('change', refresh);
      refresh();
    },
    onClick: async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const postId = pswp.currSlide?.data?.postId;
      if (!postId) return false;
      const action = coverAction(await charactersOf(postId));
      if (action.error) {
        showToast(i18n.t('characters.coverNeedsSingle'), 'error');
        return false;
      }
      const name = chineseName(action.character, tagManager.state.translations) || action.character;
      try {
        await setCharacterCover(action.character, postId);
        showToast(i18n.t('characters.coverSet', { name }), 'ok');
        onCoverSet(action.character);
      } catch {
        showToast(i18n.t('characters.coverFailed'), 'error');
      }
      return false;
    },
  });
}
