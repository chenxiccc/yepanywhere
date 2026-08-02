# Push Notifications Troubleshooting

For the cross-platform architecture, current implementation status, and known
gaps, see [Notifications](../topics/notifications.md).

Browser notifications allow Yep Anywhere to alert a subscribed desktop or
mobile browser when a session needs attention, even when no YA tab is open.

## Requirements

Push notifications require:

1. **A browser-trusted secure context** - Service workers work over HTTPS with
   a trusted certificate, or the browser's localhost development exception.
   Loading a self-signed HTTPS page after accepting a warning does not make its
   service-worker script trusted.
2. **Service Worker Support** - Modern browsers (Chrome, Firefox, Safari 16+, Edge)
3. **PushManager API** - Not available in all browsers (notably older Safari versions)
4. **Notification Permission** - User must grant permission when prompted

## Common Issues

### "Push notifications are not supported in this browser"

This can happen for several reasons:

1. **Development Mode** - Service workers are disabled by default in dev mode to avoid page reload issues. Set `VITE_ENABLE_SW=true` in your environment to enable them.

2. **Untrusted connection** - For deployed access, use a reverse proxy with
   trusted TLS termination. For local testing, prefer
   `http://localhost:<port>` (the browser's secure-context exception) or install
   a locally trusted certificate. A self-signed
   `https://127.0.0.1:<port>` origin may load while Chrome still rejects
   `sw.js` with an SSL certificate error.

3. **Unsupported Browser** - Some browsers don't support the Push API:
   - Safari < 16 on iOS
   - Some privacy-focused browsers
   - Browsers in private/incognito mode

4. **Service Worker Blocked by Auth** - If you're using basic auth with a reverse proxy, the service worker file (`sw.js`) must be accessible without authentication. See the Caddy configuration example below.

### Service Worker Registration Fails

Check the browser console for errors. Common causes:

- `sw.js` returns a 401/403 (blocked by auth)
- `sw.js` returns wrong MIME type (must be `application/javascript`)
- Mixed content (loading HTTP resources from HTTPS page)
- The page uses untrusted/self-signed HTTPS; Chrome can display the page but
  reject the service-worker script with `An SSL certificate error occurred`

## Reverse Proxy Configuration

When using a reverse proxy with basic auth, you must exclude PWA files from authentication. The service worker and manifest must be publicly accessible for the browser to register them.

### Caddy Example

```caddyfile
example.com {
    # PWA files must be accessible without auth
    @pwa_public {
        path /manifest.json /sw.js /icon-*.png /favicon.ico /badge-*.png
    }
    handle @pwa_public {
        reverse_proxy 127.0.0.1:3400
    }

    # Everything else requires auth
    handle {
        basicauth {
            username $2a$14$hashedpasswordhere
        }
        reverse_proxy 127.0.0.1:3400
    }
}
```

### nginx Example

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    # PWA files - no auth required
    location ~ ^/(manifest\.json|sw\.js|icon-.*\.png|favicon\.ico|badge-.*\.png)$ {
        proxy_pass http://127.0.0.1:3400;
    }

    # Everything else requires auth
    location / {
        auth_basic "Restricted";
        auth_basic_user_file /etc/nginx/.htpasswd;
        proxy_pass http://127.0.0.1:3400;
    }
}
```

## Testing Push Notifications

1. Go to **Settings > Notifications** in Yep Anywhere.
2. Under **This browser**, enable **Browser notifications**. The browser will
   prompt for permission.
3. Under **Devices and delivery**, click **Test** beside the subscribed
   browser. Expand **Testing and diagnostics** for test-only display and Web
   Push priority controls.

If the test notification doesn't appear:

- Check that notifications are enabled in your OS settings
- Check that the browser has notification permission for this site
- Look for errors in the browser console
- Check server logs for push delivery errors

## Still Having Issues?

Open an issue on GitHub with:

- Browser and version
- Operating system
- Any errors from the browser console
- Server logs if available

[Report an Issue](https://github.com/kzahel/yepanywhere/issues)
