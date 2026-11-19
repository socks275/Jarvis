import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGame, gameTweak, isGameRequest, mergeGameOptions, pickTheme, THEME_NAMES, themeName } from '../web/game.mjs';

test('a request for a 3D game is recognised, and other messages are left alone', () => {
  for (const text of [
    'make a 3d shooter in html',
    'build me a first-person shooter I can play in the browser',
    'code a 3D FPS game',
    'can you make a 3d game with webgl?',
    'build me a 3d fps in a dungeon',
  ]) assert.equal(isGameRequest(text), true, text);

  for (const text of [
    'hi',
    'explain how a 3d renderer works',            // a question, not a build request
    'what is the best game engine',
    'write a shooter game design document',       // not 3D
    'make a 3d model in blender',                 // 3D, but not a game
    'how does a 3d game engine work',
    '',
  ]) assert.equal(isGameRequest(text), false, text);
});

test('the theme comes from the words in the request', () => {
  assert.equal(pickTheme('make a 3d shooter on a space station'), 'space');
  assert.equal(pickTheme('build a 3d fps in a dungeon'), 'dungeon');
  assert.equal(pickTheme('a 3d shooter in the snow'), 'ice');
  assert.equal(pickTheme('make a 3d shooter in the desert'), 'sand');
  assert.equal(pickTheme('make a 3d shooter'), 'neon');
  assert.equal(themeName('space'), 'Orbital Deck');
});

test('the game is one self-contained file with no network dependency', () => {
  const html = buildGame('neon');
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<canvas id="gl"/);
  assert.match(html, /getContext\('webgl'/);
  assert.match(html, /requestPointerLock/);
  assert.match(html, /requestAnimationFrame/);
  // Movement, look and fire are all wired.
  for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'mousemove', 'pointerlockchange']) {
    assert.ok(html.includes(key), key);
  }
  // Nothing is fetched: no CDN, no fonts, no images, no remote scripts.
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+href=/i);
});

test('the embedded script is valid JavaScript in every theme', () => {
  for (const theme of THEME_NAMES) {
    const html = buildGame(theme);
    const script = html.split('<script>')[1].split('</script>')[0];
    assert.ok(script.length > 5000, `${theme} script`);
    assert.doesNotThrow(() => new Function(script), theme);
  }
});

test('a theme changes the palette it is drawn with', () => {
  const neon = buildGame('neon');
  const ice = buildGame('ice');
  assert.match(neon, /var SKY = \[0\.050, 0\.040, 0\.090\]/);
  assert.match(ice, /var SKY = \[0\.060, 0\.090, 0\.130\]/);
  assert.match(neon, /<title>Neon Arena/);
  assert.match(ice, /<title>Frost Line/);
});

test('a follow-up changes the game instead of describing the change', () => {
  assert.deepEqual(gameTweak('add a shotgun'), { spread: 3 });
  assert.equal(gameTweak('make it harder').enemySpeed > 1.5, true);
  assert.equal(gameTweak('make it easier').enemySpeed < 1.5, true);
  assert.equal(gameTweak('make the arena bigger').arena > 26, true);
  assert.equal(gameTweak('change it to a space station').theme, 'space');
  assert.equal(gameTweak('what is a rainbow?'), null);
  assert.equal(gameTweak(''), null);
});

test('the options reach the code the game is built from', () => {
  const options = mergeGameOptions({ theme: 'space' }, gameTweak('make it harder and add a shotgun'));
  const html = buildGame(options);
  const script = html.split('<script>')[1].split('</script>')[0];
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /var ARENA = 22;/);
  assert.match(script, /var shots = 3;/);
  assert.match(html, /<title>Orbital Deck/);
});
