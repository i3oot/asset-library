import { error } from '@sveltejs/kit';
import { getAssetById, getAssetRevision } from './assets';

export async function requestedAsset(id: string | undefined, revision?: string) {
  if (!id) throw error(400, 'Missing asset id');
  if (revision !== undefined && !/^[1-9]\d{0,8}$/.test(revision)) throw error(400, 'Invalid history revision');
  const asset = revision === undefined ? await getAssetById(id) : await getAssetRevision(id, Number(revision));
  if (!asset) throw error(404, 'Asset not found');
  return asset;
}
