# Sub-spec: Migrate ChatPage + remove custom CSS

**Epic:** `dashboard-ui-migration-epic.md`
**SP:** 3
**Priority:** P2
**Status:** Draft
**Depends on:** `dashboard-ui-migration--dependency-setup.md`

## Scope

Replace the custom ChatPage with the @open-hax/uxx `Chat` component and do a final CSS cleanup across all pages.

### ChatPage.tsx (474 lines → ~100 lines)
Replace the entire custom chat UI with:
```tsx
<Chat
  messages={messages}
  onSend={(content) => sendMessage(content)}
  placeholder="Ask anything..."
  showTimestamps
  showAvatars
/>
```

The @open-hax/uxx `Chat` component already supports:
- Markdown rendering
- Message streaming
- Typing indicators
- Timestamps and avatars
- File attachments

### Global CSS cleanup
After all pages are migrated:
- Remove all styles from `styles.css` that are now provided by @open-hax/uxx tokens
- Keep only page-specific layout overrides
- Target: 2267 → <500 lines (78% reduction)

### Changes
- `web/src/pages/ChatPage.tsx` — replace with @open-hax/uxx Chat component
- `web/src/styles.css` — massive cleanup pass
- `web/src/App.tsx` — remove any remaining inline styles

### Verification
- `pnpm web:build` passes
- Chat page works with streaming, markdown, file uploads
- All pages render correctly with reduced CSS
- No visual regressions in core workflows
- `styles.css` < 500 lines
