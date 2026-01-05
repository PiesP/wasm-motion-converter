# Frequently Asked Questions (FAQ)

Common questions about dropconvert-wasm and video-to-GIF/WebP conversion.

---

## General Questions

### What is dropconvert-wasm?

dropconvert-wasm is a **browser-based video converter** that turns videos into animated GIFs or WebP files entirely on your device. No uploads, no servers - everything happens in your browser using WebAssembly and modern web APIs.

### Why use browser-based conversion instead of a traditional app?

**Advantages:**
- ✅ **Privacy**: Files never leave your device
- ✅ **No installation**: Works instantly in any browser
- ✅ **Cross-platform**: Works on Windows, Mac, Linux, mobile
- ✅ **No server costs**: Completely free, no usage limits
- ✅ **Always up-to-date**: No manual updates needed

**Disadvantages:**
- ⚠️ Limited by browser memory (~500MB max file size)
- ⚠️ First-time load downloads ~30MB (FFmpeg core)
- ⚠️ Slower than native apps on low-end devices

### Is this really free?

Yes! Completely free with no usage limits, registration, or hidden fees. The app is open source and runs entirely in your browser.

### How does it work without a server?

The app uses:
- **ffmpeg.wasm**: WebAssembly port of FFmpeg (video processing)
- **WebCodecs API**: Browser's native video decoder (GPU-accelerated)
- All processing happens locally in your browser using JavaScript and WebAssembly

---

## Privacy & Security

### Where do my videos go?

**Nowhere!** Your videos:
- ✅ Stay on your device
- ✅ Never uploaded to any server
- ✅ Processed entirely in browser memory
- ✅ Are deleted when you close the tab

### Is my data safe?

Yes. The app has **no backend server** and makes no network requests except:
1. **FFmpeg core download** (~30MB, one-time from unpkg.com CDN)
2. (Optional) Analytics if enabled

Your videos are never transmitted over the network.

### Can I use this offline?

**Partially**. After first use:
- ✅ FFmpeg core files are cached for 15 minutes
- ✅ Can work offline briefly within cache window
- ❌ First visit requires internet to download FFmpeg (~30MB)

Future versions may add full offline support via Service Worker.

---

## Supported Formats

### What video formats can I convert?

**Input Formats (Container):**
- MP4
- WebM
- MOV
- AVI

**Input Codecs:**
- ✅ H.264 (AVC) - **Best compatibility**
- ✅ VP9
- ✅ AV1 - **Best quality**
- ✅ VP8
- ❌ HEVC (H.265) - **Not supported**
- ❌ ProRes - **Not supported**

**Output Formats:**
- GIF (animated)
- WebP (animated)

### Why isn't HEVC/H.265 supported?

HEVC requires patent licenses which can't be included in browser-based apps. **Workaround**: Re-encode to H.264 using a desktop tool like Handbrake or FFmpeg.

### What's the difference between GIF and WebP output?

| Feature | GIF | WebP |
|---------|-----|------|
| **File Size** | Larger (256 colors) | Smaller (24-bit color) |
| **Quality** | Lower (dithering) | Higher (better colors) |
| **Browser Support** | Universal | Chrome, Safari, Firefox, Edge |
| **Transparency** | Yes | Yes |
| **Best For** | Universal compatibility | Better quality, smaller size |

**Recommendation**:
- Use **WebP** for better quality and smaller files (works on all modern browsers)
- Use **GIF** only if you need maximum compatibility (old browsers, email clients)

---

## File Size & Quality

### What's the maximum file size I can convert?

**Recommended:** Up to **100MB** for best results

**Technical Maximum:** ~500MB (browser memory limit)

**Factors affecting limit:**
- Device memory
- Video resolution
- Browser used
- Other open tabs

### Why is my first conversion so slow?

First conversion must download **FFmpeg core files (~30MB)** from CDN. Subsequent conversions are much faster as files are cached.

**Typical times:**
- First time: ~30-40 seconds (including download)
- Subsequent: ~15-30 seconds (depending on video)

### How can I get smaller output files?

1. **Lower scale**: Use 0.5× or 0.75× size
2. **Lower quality**: Select "Low" or "Medium" quality
3. **Trim video**: Shorter duration = smaller file
4. **Choose WebP**: ~30-50% smaller than GIF for same quality
5. **Lower framerate**: Fewer frames = smaller size

### How can I improve output quality?

1. **Use high quality source**: Better input = better output
2. **Select "High" quality**: More colors, less compression
3. **Use WebP format**: Better color depth than GIF
4. **Use 1× scale**: Don't downscale if not needed
5. **Use modern codec**: AV1 or VP9 source for WebCodecs path

---

## Performance

### Why is conversion slow on my device?

**Common causes:**
1. **No SharedArrayBuffer** (single-threaded FFmpeg)
   - Fix: Ensure COOP/COEP headers set (see deployment docs)
   - 3-4× slower without multithreading

2. **Large file size**
   - Solution: Scale down, trim video, lower quality

3. **Low-end device**
   - Mobile devices and old computers are slower
   - Try: Lower scale, shorter videos

4. **Many browser tabs open**
   - Close unused tabs to free memory

### What is WebCodecs and why does it matter?

**WebCodecs** is a modern browser API that uses **GPU acceleration** for video decoding:

| Path | Speed | Browsers |
|------|-------|----------|
| WebCodecs | ⚡ ~2× faster | Chrome, Edge (best) |
| FFmpeg | 🐢 Slower but universal | All browsers |

**App automatically selects best path** based on:
- Browser support
- Video codec
- Output format

### How do I enable SharedArrayBuffer for faster conversion?

SharedArrayBuffer requires **cross-origin isolation** headers on your deployment.

**Check if enabled:**
```javascript
console.log(crossOriginIsolated); // Should be true
```

**How to enable:**
- See [DEPLOYMENT.md](./DEPLOYMENT.md) for platform-specific instructions
- Requires COOP/COEP headers on server

**Performance difference:**
- With SharedArrayBuffer: 4 threads, ~3× faster
- Without: Single thread, significantly slower

---

## Browser Compatibility

### Which browsers work best?

**Best Performance:**
- Chrome 94+ (Desktop & Android)
- Edge 94+

**Good Performance:**
- Safari 16.4+ (limited WebCodecs)
- Firefox 120+ (no WebCodecs, FFmpeg only)

**All modern browsers work**, but Chrome/Edge are fastest due to WebCodecs support.

See [BROWSER_COMPATIBILITY.md](./BROWSER_COMPATIBILITY.md) for detailed matrix.

### Does it work on mobile?

✅ **Yes!** Works on:
- Chrome (Android)
- Safari (iOS)
- Samsung Internet
- Firefox Mobile

**Limitations on mobile:**
- Stricter memory limits (use smaller files)
- Battery usage (disable battery saver during conversion)
- Slower than desktop

**Recommendations for mobile:**
- Keep videos under 30 seconds
- Use 0.5× or 0.75× scale
- Close other apps
- Keep app in foreground

### Does it work in private/incognito mode?

**Partially**. Private mode may:
- ❌ Disable SharedArrayBuffer (slower conversions)
- ✅ FFmpeg still works (single-threaded)

**Recommendation**: Use regular browsing mode for best performance.

---

## Technical Questions

### What is "cross-origin isolation"?

Cross-origin isolation is a security requirement for using SharedArrayBuffer (needed for FFmpeg multithreading).

**Required HTTP headers:**
```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

**Why required?** Security mitigation against Spectre attacks.

**How to enable?** See [DEPLOYMENT.md](./DEPLOYMENT.md)

### Why does the warning say "SharedArrayBuffer unavailable"?

This means cross-origin isolation headers are not set. The app still works but uses single-threaded FFmpeg (slower).

**Fix**: Set COOP/COEP headers on your deployment.

### Can I use this in my own project?

✅ **Yes!** The project is open source (check LICENSE). You can:
- Use it as-is
- Fork and modify
- Deploy your own instance
- Integrate into other projects

**Requirements:**
- Credit original project
- Follow license terms
- Maintain COOP/COEP headers for SharedArrayBuffer

### How do I report bugs or request features?

- **Bugs**: Open issue on GitHub
- **Features**: Open discussion or feature request
- **Security**: Follow `.github/SECURITY.md`

See [CONTRIBUTING.md](../CONTRIBUTING.md) for details.

---

## Usage Questions

### Can I convert multiple videos at once?

**Not currently**. The app processes one video at a time.

**Workaround**: Convert one, download, select next video.

**Future**: Batch conversion may be added in future versions.

### Can I trim videos before converting?

**Not currently**. The app converts the entire video.

**Workaround**: Use a video editor to trim before uploading:
- Desktop: VLC, FFmpeg, Handbrake
- Online: Various video trimming tools

**Future**: Built-in trimming may be added.

### How do I save the converted file?

1. Wait for conversion to complete
2. Preview appears with download button
3. Click "Download GIF" or "Download WebP"
4. File saves to your default downloads folder

### Can I convert GIF to video?

**No**, this app only converts **video → GIF/WebP**.

**For GIF → Video**: Use FFmpeg desktop tool:
```bash
ffmpeg -i input.gif -pix_fmt yuv420p output.mp4
```

---

## Error Messages

### "Unsupported format" error

**Cause**: Video codec not supported (likely HEVC/H.265)

**Solution**:
1. Check video codec using MediaInfo or FFmpeg
2. Re-encode to H.264:
   ```bash
   ffmpeg -i input.mov -c:v libx264 output.mp4
   ```
3. Try again with re-encoded video

### "Out of memory" error

**Cause**: Video too large for available browser memory

**Solutions**:
1. Use lower scale (0.5× or 0.75×)
2. Trim video to shorter duration
3. Close other browser tabs/apps
4. Try on desktop instead of mobile
5. Use lower quality setting

### "Network error downloading FFmpeg"

**Cause**: Can't download FFmpeg core from CDN

**Solutions**:
1. Check internet connection
2. Disable ad blockers (may block unpkg.com)
3. Check if corporate firewall blocks CDN
4. Try different network
5. Wait and retry (CDN may be temporarily down)

---

## Optimization Tips

### How do I get the smallest possible file?

1. **Format**: Use WebP (30-50% smaller than GIF)
2. **Scale**: Use 0.5× size
3. **Quality**: Use "Low" quality
4. **Duration**: Trim to shortest duration needed
5. **Framerate**: Lower FPS in quality settings

**Example**: 10-second 1080p video
- Default GIF (1×, high): ~15-20MB
- Optimized WebP (0.5×, medium): ~2-3MB

### How do I get the best quality?

1. **Format**: Use WebP
2. **Scale**: Use 1× (full size)
3. **Quality**: Use "High"
4. **Source**: Use high-quality source video
5. **Browser**: Use Chrome/Edge for WebCodecs acceleration

### What settings should I use for social media?

**Twitter:**
- Format: GIF
- Scale: 0.75× or 0.5×
- Duration: <15 seconds
- Max size: 15MB

**Discord:**
- Format: GIF or WebP
- Scale: 0.5×
- Max size: 8MB (free) / 50MB (Nitro)

**Slack:**
- Format: GIF
- Scale: 0.5×
- Max size: 5MB

---

## Comparison with Other Tools

### How does this compare to Gifski/Photoshop/Cloudconvert?

| Feature | dropconvert-wasm | Desktop Tools | Cloud Services |
|---------|------------------|---------------|----------------|
| **Privacy** | ✅ Full (local) | ✅ Full (local) | ❌ Upload required |
| **Speed** | ✔️ Good | ⭐ Best | ✔️ Good |
| **Quality** | ✔️ Good | ⭐ Best | ✔️ Good |
| **File Size Limit** | 500MB (memory) | Unlimited | Varies (often 100MB) |
| **Cost** | Free | One-time cost | Free tier limited |
| **Installation** | None | Required | None |
| **Offline** | Partial | ✅ Yes | ❌ No |

**Use dropconvert-wasm when:**
- You want privacy (no uploads)
- You don't want to install software
- You need quick, occasional conversions
- File size is under 500MB

**Use desktop tools when:**
- You need highest quality
- You process very large files (>1GB)
- You need advanced features (custom palettes, dithering)
- You convert frequently

---

## Advanced Usage

### Can I customize FFmpeg arguments?

**Not through UI**. For custom FFmpeg args:
1. Fork the project
2. Edit `src/services/ffmpeg-service.ts`
3. Modify command generation functions
4. Deploy your own instance

### How do I force a specific conversion path?

For debugging/testing:

```javascript
// Force FFmpeg path
localStorage.setItem('forceFFmpegPath', 'true');

// Force WebCodecs path
localStorage.setItem('forceWebCodecsPath', 'true');

// Reset to automatic
localStorage.clear();
```

Reload page after setting.

### Can I integrate this into my app?

✅ **Yes!** The core services can be imported:

```typescript
import { convertVideo } from './services/conversion-service';

const blob = await convertVideo(
  file,
  { format: 'gif', quality: 'high', scale: '1' },
  (progress, message) => console.log(progress, message)
);
```

See [API_REFERENCE.md](./API_REFERENCE.md) for details.

---

## Future Features

### What features are planned?

Potential future additions (no timeline):
- Video trimming in browser
- Batch conversion
- Additional output formats (MP4, APNG)
- Custom frame rate control
- Palette optimization for GIF
- Service Worker for offline use
- More codec support (as browsers add support)

**Want to contribute?** See [CONTRIBUTING.md](../CONTRIBUTING.md)

### Will you add [specific feature]?

Open a **feature request** on GitHub! No guarantees, but community input helps prioritize development.

---

## Troubleshooting

For common issues and solutions, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

For browser-specific issues, see [BROWSER_COMPATIBILITY.md](./BROWSER_COMPATIBILITY.md).

---

## Still Have Questions?

- 📖 Read [ARCHITECTURE.md](./ARCHITECTURE.md) for technical details
- 🐛 Check [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues
- 🌐 Check [BROWSER_COMPATIBILITY.md](./BROWSER_COMPATIBILITY.md) for browser support
- 💬 Open a GitHub Discussion
- 🐞 Report bugs on GitHub Issues

---

**Last Updated**: January 2025
