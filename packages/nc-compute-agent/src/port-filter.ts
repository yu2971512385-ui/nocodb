import { AGENT_PORT } from './protocol';
import type { FactoryPort } from 'nocodb-sdk';

/** Which listeners in an instance are worth offering as a preview. Shared by the agent and the backend. */

/**
 * Listeners the instance runs for itself. Nobody wants to preview sshd, and a
 * privileged port is only interesting when a recognisable app server holds it.
 */
const SYSTEM_PROCESSES =
  /^(sshd|systemd(-resolve[d]?|-networkd)?|resolved|dnsmasq|chronyd|ntpd|rpcbind|snapd|containerd|dockerd|docker-proxy|exim4?|postfix|master|agetty|cloud-init|dhclient|NetworkManager|rsyslogd|envd|x11vnc|Xvfb|websockify)$/i;

/**
 * The desktop plumbing: VNC, its noVNC bridge (shown through the live
 * screen, not a preview) and the agent browser's DevTools, which drives it.
 */
const DESKTOP_PORTS = new Set([5900, 6080, 9222]);

const APP_PROCESSES =
  /^(node|nodejs|npm|pnpm|yarn|bun|deno|vite|next|nuxt|python[\d.]*|uvicorn|gunicorn|ruby|rails|puma|php|php-fpm|java|gradle|go|dotnet|cargo|caddy|nginx|httpd|apache2|webpack|esbuild|turbo|astro|remix|serve|http-server|storybook)$/i;

/**
 * E2B's own agent. It answers every request, so previewing it would show a
 * working page that is not the user's app at all.
 */
const ENVD_PORT = 49983;

/** A port the instance runs for itself, never offered or opened as a preview. */
export function isInternalPort(port: number): boolean {
  return port === ENVD_PORT || port === AGENT_PORT || DESKTOP_PORTS.has(port);
}

/** The listeners worth offering as a preview. */
export function appPorts(ports: FactoryPort[]): FactoryPort[] {
  return ports
    .filter((p) => {
      if (isInternalPort(p.port)) return false;

      const name = (p.process ?? '').split('/').pop() ?? '';

      if (SYSTEM_PROCESSES.test(name)) return false;

      // An unprivileged port is the agent's doing until proven otherwise; a
      // privileged one has to name a server we recognise.
      return p.port >= 1024 || APP_PROCESSES.test(name);
    })
    .sort((a, b) => a.port - b.port);
}
