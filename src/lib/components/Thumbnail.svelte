<script lang="ts">
  import { thumbHashToDataURL } from "thumbhash";
  let { src, thumbhash, alt }: { src?: string; thumbhash?: string; alt: string } = $props();
  let loaded = $state(false);
  const placeholder = $derived.by(() => {
    if (!thumbhash) return "";
    try { return thumbHashToDataURL(Uint8Array.from(atob(thumbhash), char => char.charCodeAt(0))); }
    catch { return ""; }
  });
  $effect(() => { src; loaded = false; });
</script>

<div class="thumbnail" style:background-image={placeholder ? `url("${placeholder}")` : undefined}>
  {#if src}<img {src} {alt} loading="lazy" draggable="false" class:loaded onload={() => { loaded = true; }} />{/if}
</div>

<style>
  .thumbnail { width: 100%; height: 100%; background-size: contain; background-position: center; background-repeat: no-repeat; }
  img { display: block; width: 100%; height: 100%; object-fit: contain; opacity: 0; transition: opacity 150ms ease; }
  img.loaded { opacity: 1; }
  @media (prefers-reduced-motion: reduce) { img { transition: none; } }
</style>
