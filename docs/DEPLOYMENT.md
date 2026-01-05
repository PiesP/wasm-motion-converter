# Deployment Guide

This guide covers deploying **dropconvert-wasm** to various hosting platforms with proper configuration for SharedArrayBuffer and cross-origin isolation.

---

## Table of Contents

1. [Requirements](#requirements)
2. [Cloudflare Pages](#cloudflare-pages-recommended)
3. [Netlify](#netlify)
4. [Vercel](#vercel)
5. [GitHub Pages](#github-pages)
6. [Self-Hosted](#self-hosted)
7. [Environment Variables](#environment-variables)
8. [Troubleshooting](#troubleshooting)

---

## Requirements

### Critical Headers

For SharedArrayBuffer and FFmpeg multithreading to work, your deployment **must** set these HTTP headers:

```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

Without these headers:
- `crossOriginIsolated` will be `false`
- SharedArrayBuffer will be unavailable
- FFmpeg will run in single-threaded mode (slower)

### Build Configuration

**Build command:**
```bash
pnpm build
```

**Output directory:**
```
dist/
```

**Node version:**
```
24.12.0+ (or match .volta/node version)
```

---

## Cloudflare Pages (Recommended)

Cloudflare Pages is the recommended platform due to excellent support for custom headers.

### Setup Steps

1. **Connect Repository**
   - Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
   - Pages → Create a project
   - Connect your GitHub/GitLab repository

2. **Configure Build Settings**
   ```
   Framework preset:     Vite
   Build command:        pnpm build
   Build output dir:     dist
   Node version:         24
   ```

3. **Install pnpm**
   - In "Environment variables" section:
     ```
     NPM_CONFIG_PRODUCTION = false
     ```
   - Or use build command:
     ```bash
     npm install -g pnpm && pnpm build
     ```

4. **Headers Configuration**

   The headers are automatically configured via `public/_headers` file:

   ```
   /*
     Cross-Origin-Embedder-Policy: require-corp
     Cross-Origin-Opener-Policy: same-origin
   ```

   This file is copied to `dist/_headers` during the build and Cloudflare Pages will apply these headers automatically.

5. **Deploy**
   - Click "Save and Deploy"
   - Wait for build to complete
   - Your app will be available at `https://<project-name>.pages.dev`

### Custom Domain (Optional)

1. Go to your Pages project → Custom domains
2. Add your domain (e.g., `convert.example.com`)
3. Update DNS records as instructed
4. Wait for SSL certificate provisioning

### Preview Deployments

Cloudflare Pages automatically creates preview deployments for pull requests:
- Each PR gets a unique URL: `https://<commit-hash>.<project-name>.pages.dev`
- Headers are applied to preview deployments too

---

## Netlify

Netlify supports custom headers via `_headers` file or `netlify.toml`.

### Setup Steps

1. **Connect Repository**
   - Go to [Netlify Dashboard](https://app.netlify.com/)
   - Add new site → Import from Git
   - Select your repository

2. **Build Settings**
   ```
   Build command:        pnpm build
   Publish directory:    dist
   ```

3. **Node Version**

   Create `/.nvmrc` file:
   ```
   24
   ```

4. **Install pnpm**

   In Netlify build settings → Environment variables:
   ```
   NPM_FLAGS = --version  # This installs pnpm
   ```

   Or modify build command:
   ```bash
   npm install -g pnpm && pnpm build
   ```

5. **Headers Configuration**

   **Option A: Using `_headers` file** (Already configured)

   Ensure `public/_headers` exists with:
   ```
   /*
     Cross-Origin-Embedder-Policy: require-corp
     Cross-Origin-Opener-Policy: same-origin
   ```

   **Option B: Using `netlify.toml`**

   Create `/netlify.toml`:
   ```toml
   [build]
     command = "pnpm build"
     publish = "dist"

   [[headers]]
     for = "/*"
     [headers.values]
       Cross-Origin-Embedder-Policy = "require-corp"
       Cross-Origin-Opener-Policy = "same-origin"
   ```

6. **Deploy**
   - Click "Deploy site"
   - Your app will be available at `https://<random-name>.netlify.app`

### Verify Headers

After deployment, check headers with:
```bash
curl -I https://your-site.netlify.app
```

Look for:
```
cross-origin-embedder-policy: require-corp
cross-origin-opener-policy: same-origin
```

---

## Vercel

Vercel requires `vercel.json` configuration for custom headers.

### Setup Steps

1. **Connect Repository**
   - Go to [Vercel Dashboard](https://vercel.com/dashboard)
   - Import Project → Select repository

2. **Build Settings**
   ```
   Framework Preset:     Vite
   Build Command:        pnpm build
   Output Directory:     dist
   Install Command:      pnpm install
   ```

3. **Node Version**

   Vercel auto-detects from `package.json` engines field:
   ```json
   {
     "engines": {
       "node": ">=24.0.0"
     }
   }
   ```

4. **Headers Configuration**

   Create `/vercel.json`:
   ```json
   {
     "headers": [
       {
         "source": "/(.*)",
         "headers": [
           {
             "key": "Cross-Origin-Embedder-Policy",
             "value": "require-corp"
           },
           {
             "key": "Cross-Origin-Opener-Policy",
             "value": "same-origin"
           }
         ]
       }
     ]
   }
   ```

5. **Deploy**
   - Click "Deploy"
   - Your app will be available at `https://<project-name>.vercel.app`

### Important Notes

- Vercel does NOT read `public/_headers` - you must use `vercel.json`
- Headers apply to all routes automatically
- Preview deployments also get the headers

---

## GitHub Pages

GitHub Pages is **NOT recommended** because it doesn't support custom headers natively. However, there's a workaround using Service Worker.

### Limitations

- SharedArrayBuffer will be unavailable
- FFmpeg will run single-threaded (slower)
- Not recommended for production use

### Setup (If you must use GitHub Pages)

1. **Build and Deploy**

   Add `.github/workflows/deploy.yml`:
   ```yaml
   name: Deploy to GitHub Pages

   on:
     push:
       branches: [main]

   jobs:
     deploy:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v3

         - name: Setup Node
           uses: actions/setup-node@v3
           with:
             node-version: '24'

         - name: Install pnpm
           run: npm install -g pnpm

         - name: Install dependencies
           run: pnpm install

         - name: Build
           run: pnpm build

         - name: Deploy
           uses: peaceiris/actions-gh-pages@v3
           with:
             github_token: ${{ secrets.GITHUB_TOKEN }}
             publish_dir: ./dist
   ```

2. **Enable GitHub Pages**
   - Repository Settings → Pages
   - Source: Deploy from a branch
   - Branch: `gh-pages`

3. **Result**
   - Deployed to `https://<username>.github.io/<repo-name>/`
   - Will show "SharedArrayBuffer unavailable" warning
   - Conversions will work but slower

---

## Self-Hosted

For self-hosted deployments on your own server.

### Using Nginx

**nginx.conf:**
```nginx
server {
    listen 80;
    server_name convert.example.com;

    root /var/www/dropconvert/dist;
    index index.html;

    # Critical headers for SharedArrayBuffer
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Opener-Policy "same-origin" always;

    # Security headers (optional but recommended)
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
        add_header Cross-Origin-Opener-Policy "same-origin" always;
    }

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

**Deploy:**
```bash
# Build locally
pnpm build

# Copy to server
scp -r dist/* user@server:/var/www/dropconvert/dist/

# Reload nginx
ssh user@server 'sudo nginx -s reload'
```

### Using Apache

**.htaccess** (place in `/dist` folder):
```apache
# Headers for SharedArrayBuffer
Header set Cross-Origin-Embedder-Policy "require-corp"
Header set Cross-Origin-Opener-Policy "same-origin"

# SPA fallback
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule . /index.html [L]
</IfModule>
```

**Deploy:**
```bash
pnpm build
scp -r dist/* user@server:/var/www/html/
```

### Using Docker

**Dockerfile:**
```dockerfile
FROM node:24-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

**nginx.conf** (for Docker):
```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Opener-Policy "same-origin" always;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

**Build and Run:**
```bash
docker build -t dropconvert .
docker run -p 8080:80 dropconvert
```

---

## Environment Variables

### Optional Variables

**`VITE_ENABLE_ADS`** (default: `false`)
- Set to `true` to enable ads (if implemented)
- Example: `VITE_ENABLE_ADS=false pnpm build`

### Platform-Specific

**Cloudflare Pages:**
- Set in project settings → Environment variables
- Example: `VITE_ENABLE_ADS = false`

**Netlify:**
- Set in site settings → Build & deploy → Environment
- Example: `VITE_ENABLE_ADS = false`

**Vercel:**
- Set in project settings → Environment Variables
- Example: `VITE_ENABLE_ADS = false`

---

## Post-Deployment Checklist

After deploying, verify everything works:

### 1. Check Cross-Origin Isolation

Open browser console on your deployed site:
```javascript
console.log('crossOriginIsolated:', crossOriginIsolated);
console.log('SharedArrayBuffer:', typeof SharedArrayBuffer);
```

Expected output:
```
crossOriginIsolated: true
SharedArrayBuffer: function
```

### 2. Check Headers

```bash
curl -I https://your-site.com
```

Look for:
```
cross-origin-embedder-policy: require-corp
cross-origin-opener-policy: same-origin
```

### 3. Test Conversion

1. Upload a test video
2. Wait for FFmpeg initialization (~30MB download)
3. Convert to GIF
4. Verify output downloads successfully

### 4. Test on Mobile

- Open site on mobile device
- Check for warnings
- Test conversion flow
- Verify SharedArrayBuffer availability (may be limited on some mobile browsers)

---

## Continuous Deployment

### Automatic Deployments

Most platforms (Cloudflare Pages, Netlify, Vercel) support automatic deployments:

1. Push to `main` branch → triggers production deployment
2. Open PR → triggers preview deployment
3. Merge PR → automatically deploys to production

### GitHub Actions (for other platforms)

If using a platform without built-in GitHub integration, create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node
        uses: actions/setup-node@v3
        with:
          node-version: '24'

      - name: Install pnpm
        run: npm install -g pnpm

      - name: Install dependencies
        run: pnpm install

      - name: Build
        run: pnpm build

      - name: Deploy to server
        run: |
          # Your deployment script here
          # Example: rsync, scp, or platform CLI
```

---

## Troubleshooting

### Headers Not Applied

**Symptoms:**
- `crossOriginIsolated === false`
- "SharedArrayBuffer unavailable" warning

**Solutions:**
1. Check that `public/_headers` exists
2. Verify headers in browser Network tab
3. Clear cache and hard reload (Ctrl+Shift+R)
4. Check platform-specific header configuration

### Build Failures

**Common issues:**
- Node version mismatch → Use Node 24+
- pnpm not installed → Add pnpm installation to build command
- Out of memory → Increase build memory limit

### FFmpeg Not Loading

**Symptoms:**
- "Loading FFmpeg" stuck at 0%
- Network errors in console

**Solutions:**
1. Check Content Security Policy (CSP) headers
2. Verify CDN access (unpkg.com)
3. Check network connectivity
4. Review browser console for errors

---

## Performance Optimization

### Build Optimization

**Enable build analysis:**
```bash
pnpm analyze
```

This generates a bundle size visualization.

### CDN Configuration

Consider using a CDN for faster global access:
- Cloudflare Pages has built-in global CDN
- Netlify has global edge network
- Vercel has Edge Network

### Caching Strategy

The app automatically caches FFmpeg core files for 15 minutes using in-memory cache.

---

## Security Considerations

### Content Security Policy (Optional)

Add CSP headers for additional security:
```
Content-Security-Policy: default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  connect-src 'self' https://unpkg.com;
  style-src 'self' 'unsafe-inline';
```

Note: `'wasm-unsafe-eval'` is required for FFmpeg.wasm

### HTTPS Only

Always serve the app over HTTPS:
- Cloudflare Pages, Netlify, Vercel provide automatic HTTPS
- For self-hosted, use Let's Encrypt or Cloudflare SSL

---

## Monitoring

### Error Tracking

Consider integrating error tracking:
- Sentry
- LogRocket
- Rollbar

### Analytics

Track usage with:
- Cloudflare Web Analytics (privacy-friendly)
- Plausible Analytics
- Google Analytics

---

## Rollback Strategy

### Cloudflare Pages / Netlify / Vercel

All platforms support rollback:
1. Go to deployments list
2. Find previous successful deployment
3. Click "Publish" or "Promote to production"

### Self-Hosted

```bash
# Keep previous builds
mv dist dist.backup
# Build new version
pnpm build
# If issues occur
rm -rf dist
mv dist.backup dist
```

---

For deployment issues, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
