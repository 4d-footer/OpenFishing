<script lang="ts">
	import { thumbTiles } from '#lib/waters/geo.js';

	let { lat, lng, size = 88, alt }: { lat: number | null; lng: number | null; size?: number; alt: string } = $props();
	const tiles = $derived(lat !== null && lng !== null ? thumbTiles(lat, lng, 12, size) : []);
</script>

{#if tiles.length}
	<div role="img" aria-label={alt} title="USGS The National Map"
		style="position:relative; flex:none; width:{size}px; height:{size}px; border-radius:10px; overflow:hidden; border:1px solid var(--of-border-subtle); background:var(--of-bg);">
		{#each tiles as tile (tile.url)}
			<img src={tile.url} alt="" loading="lazy" draggable="false" width="256" height="256"
				style="position:absolute; left:{tile.left}px; top:{tile.top}px; max-width:none; user-select:none;" />
		{/each}
		<span style="position:absolute; left:50%; top:50%; width:12px; height:12px; margin:-6px 0 0 -6px; border-radius:50%; background:var(--of-accent-solid); border:2px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,0.45);"></span>
	</div>
{/if}
