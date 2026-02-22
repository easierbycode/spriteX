import { writeFile } from 'node:fs/promises';

async function downloadAtlas() {
  const gameName = process.argv[2];
  const atlasName = process.argv[3];

  if (!gameName || !atlasName) {
    console.error('Usage: node download-atlas.mjs <gameName> <atlasName>');
    process.exit(1);
  }

  // Mapping logic as requested in the example
  // evil-invaders-phaser4 -> evil-invaders
  let gameId = gameName.replace('-phaser4', '');
  // game_asset -> game_ui
  let atlasId = atlasName === 'game_asset' ? 'game_ui' : atlasName;

  console.log(`Mapping: gameName=${gameName} -> gameId=${gameId}, atlasName=${atlasName} -> atlasId=${atlasId}`);

  const baseUrl = 'https://evil-invaders-default-rtdb.firebaseio.com';
  const fullPath = `games/${gameId}/atlases/${atlasId}.json`;
  const rootPath = `atlases/${atlasId}.json`;

  let response;
  let url = `${baseUrl}/${fullPath}`;
  console.log(`Fetching from ${url}...`);
  response = await fetch(url);
  let data = await response.json();

  // If not found at the specific game path, try the root atlases path as a fallback
  if (!data || data === null) {
    url = `${baseUrl}/${rootPath}`;
    console.log(`Not found at ${fullPath}. Trying fallback: ${url}...`);
    response = await fetch(url);
    data = await response.json();
  }

  if (!data || data === null) {
    console.error('Atlas data not found in Firebase RTDB.');
    process.exit(1);
  }

  let { json, png } = data;

  if (!json || !png) {
    console.error('Incomplete atlas data (missing json or png field).');
    process.exit(1);
  }

  // Handle json if it's stored as a string (normalizeAtlasJson logic)
  if (typeof json === 'string') {
    try {
      let parsed = JSON.parse(json.trim());
      if (typeof parsed === 'string') {
        parsed = JSON.parse(parsed.trim());
      }
      json = parsed;
    } catch (e) {
      console.warn('Failed to parse JSON string, saving as raw string.');
    }
  }

  // Save JSON
  const jsonFilename = `${atlasId}.json`;
  await writeFile(jsonFilename, typeof json === 'string' ? json : JSON.stringify(json, null, 2));
  console.log(`Saved ${jsonFilename}`);

  // Save PNG
  // Strip data:image/png;base64, prefix if present
  const base64Data = png.startsWith('data:') ? png.split(',')[1] : png;
  const pngFilename = `${atlasId}.png`;
  await writeFile(pngFilename, Buffer.from(base64Data, 'base64'));
  console.log(`Saved ${pngFilename}`);

  console.log('Download complete.');
}

downloadAtlas().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
