# Summary

Explain **what** this pull request changes and **why**.

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / internal improvement
- [ ] Documentation only

## How to test

Describe how reviewers can verify the change, including relevant npm scripts
(for example):

```bash
pnpm build
pnpm check
pnpm lint
```

If tests are not required, briefly explain why.

## Checklist

- [ ] Code and comments are written in **English**
- [ ] I confirmed the app still runs fully in-browser (no server upload)
- [ ] I verified COOP/COEP headers are present (`public/_headers`) when SharedArrayBuffer is required
- [ ] I ran `pnpm lint`
- [ ] I ran `pnpm typecheck`
- [ ] I ran `pnpm build`
- [ ] I updated docs if user-visible behavior changed
- [ ] I reviewed `.github/SECURITY.md` if security/privacy behavior changed
