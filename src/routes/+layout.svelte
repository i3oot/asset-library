<script lang="ts">
  import "../app.css";
  import "../fonts.css";
  import "../toasts.css";
  import favicon from "$lib/assets/favicon.svg";
  import favicon96 from "$lib/assets/favicon-96x96.png";
  import appleTouchIcon from "$lib/assets/apple-touch-icon.png";
  import faviconIco from "$lib/assets/favicon.ico";
  import siteManifest from "$lib/assets/site.webmanifest";
  import { Toaster } from "svelte-sonner";

  let { children, data } = $props();
</script>

<svelte:head>
  <title>Asset Library</title>
  <link rel="icon" href={favicon} />
  <link rel="icon" type="image/png" href={favicon96} sizes="96x96" />
  <link rel="shortcut icon" href={faviconIco} />
  <link rel="apple-touch-icon" sizes="180x180" href={appleTouchIcon} />
  <meta name="apple-mobile-web-app-title" content="Asset Lib" />
  <link rel="manifest" href={siteManifest} />
</svelte:head>

{#if data.auth?.enabled && data.auth.user}
  <div class="account">
    <span>{data.auth.user.name}</span>
    <form method="POST" action="/auth/logout"><button type="submit">Sign out</button></form>
  </div>
{/if}
{@render children()}

<Toaster
  position="top-right"
  toastOptions={{ unstyled: true, class: "toast" }}
/>

<style>
  .account { max-width: 1168px; margin: 0.5rem auto 0; padding: 0 1rem; display: flex; justify-content: flex-end; gap: 1rem; align-items: center; }
  .account form { margin: 0; }
  .account button { background: var(--surface-inset); color: var(--app-text); border: 1px solid var(--borderHoverColor); border-radius: 6px; padding: 0.35rem 0.6rem; cursor: pointer; }
</style>
