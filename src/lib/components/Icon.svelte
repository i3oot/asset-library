<script lang="ts">
  import type { SVGAttributes } from "svelte/elements";
  import bundledIcons from "$lib/icons.generated.json";
  let { icon, width = "1em", height = "1em", ...attributes }: SVGAttributes<SVGSVGElement> & { icon: string } = $props();
  const icons: Record<string, { body: string; width: number; height: number }> = bundledIcons;
  const data = $derived(icons[icon]);
</script>

{#if data}
  <svg xmlns="http://www.w3.org/2000/svg" {width} {height} viewBox={`0 0 ${data.width} ${data.height}`} fill="currentColor" aria-hidden="true" {...attributes}>
    {@html data.body}
  </svg>
{/if}
