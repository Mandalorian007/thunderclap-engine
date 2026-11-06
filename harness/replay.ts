/**
 * Input replay page (ws/input-replay): a sprite moved by WASD, the arrows or the pad's left
 * stick, with a dash on Space or pad button 0. On load the page feeds a scripted 3 s session
 * (180 ticks) into its `Input` while an `InputRecorder` watches, then puts the sprite back and
 * replays the recording through `createInputPlayback`, comparing every tick's action states and
 * the final position. After that the DOM is attached and the page is a live demo.
 */
import { GameLoop } from '@thunderclap/engine/core';
import {
  createInputPlayback,
  createInputRecorder,
  type GamepadLike,
  Input,
  type InputPlayback,
  parseRecording,
  serializeRecording,
} from '@thunderclap/engine/input';
import { boot } from '@thunderclap/engine/platform';
import { gpuDiagnostics, installGpuErrorLogging, Renderer } from '@thunderclap/engine/render';
import type { HarnessReplayApi, HarnessReplayState } from './replay-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const START: [number, number] = [LOGICAL.width / 2, LOGICAL.height / 2];
/** Ticks the scripted session lasts: 3 s at the fixed 60 Hz step. */
const SCRIPT_TICKS = 180;
const SPEED_PER_S = 420;
const DASH_PX = 90;

type Action = 'left' | 'right' | 'up' | 'down' | 'dash';

const state: HarnessReplayState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  phase: 'record',
  recordedTicks: 0,
  replayTick: 0,
  positionAfterRecord: null,
  positionAfterReplay: null,
  equal: null,
  mismatches: 0,
  firstMismatch: null,
  json: '',
  roundTrip: null,
  position: [START[0], START[1]],
  gpuErrors: 0,
};

const api: HarnessReplayApi = { state };
window.__harnessReplay = api;

/** The pads the script presents while recording; empty otherwise (the playback supplies its own). */
const scriptedPads: GamepadLike[] = [];
let realPads = false;

function getGamepads(): readonly (GamepadLike | null)[] {
  if (realPads) {
    try {
      return navigator.getGamepads?.() ?? [];
    } catch {
      return [];
    }
  }
  return scriptedPads;
}

function stick(x: number, y: number, a = 0): GamepadLike {
  return {
    connected: true,
    buttons: [{ pressed: a >= 0.5, value: a }],
    axes: [x, y],
  };
}

/** What the scripted session feeds on tick `t`, before `update()`. */
function scriptTick(t: number, input: Input<Action>): void {
  switch (t) {
    case 0:
      // The pointer position is not part of `releaseAll()`, so a session that reads it starts
      // by placing it; otherwise the replay would inherit wherever the pointer was left.
      input.pointerAt(100, 100);
      input.keyDown('KeyD');
      break;
    case 45:
      input.keyUp('KeyD');
      input.keyDown('KeyS');
      break;
    case 70:
      // Two taps between ticks: the second queues onto the next tick.
      input.keyDown('Space');
      input.keyUp('Space');
      input.keyDown('Space');
      input.keyUp('Space');
      break;
    case 80:
      input.keyUp('KeyS');
      break;
    case 90:
      scriptedPads.push(stick(-0.8, 0));
      break;
    case 120:
      scriptedPads[0] = stick(0, -0.6);
      break;
    case 140:
      scriptedPads[0] = stick(0, -0.6, 1);
      break;
    case 141:
      scriptedPads[0] = stick(0, -0.6);
      break;
    case 150:
      scriptedPads.length = 0;
      input.pointerAt(300, 200);
      input.buttonDown(0);
      break;
    case 155:
      input.buttonUp(0);
      input.keyDown('ArrowRight');
      input.keyDown('ArrowUp');
      break;
    case 170:
      input.releaseAll();
      break;
  }
}

/** One tick of the "game": move the sprite from the action states. */
function moveSprite(input: Input<Action>, dt: number): void {
  const p = state.position;
  const s = SPEED_PER_S * dt;
  p[0] += (input.value('right') - input.value('left')) * s;
  p[1] += (input.value('down') - input.value('up')) * s;
  if (input.pressed('dash')) p[0] += DASH_PX;
}

/** The per-tick action states as one string, for the record versus replay comparison. */
function stateKey(input: Input<Action>): string {
  let k = '';
  for (const a of ['left', 'right', 'up', 'down', 'dash'] as const) {
    const s = input.state(a);
    k += `${a}:${s.pressed ? 1 : 0}${s.held ? 1 : 0}${s.released ? 1 : 0}:${s.value.toFixed(4)};`;
  }
  const pt = input.pointer;
  return `${k}p:${pt.x},${pt.y},${pt.down ? 1 : 0};${input.lastDevice}`;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine input replay demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const renderer = new Renderer(gpu, {
    logicalWidth: LOGICAL.width,
    logicalHeight: LOGICAL.height,
  });
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);
  surface.onResize(({ backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));

  const input = new Input<Action>(
    {
      left: [{ key: 'KeyA' }, { key: 'ArrowLeft' }, { padAxis: 0, dir: -1 }],
      right: [{ key: 'KeyD' }, { key: 'ArrowRight' }, { padAxis: 0, dir: 1 }],
      up: [{ key: 'KeyW' }, { key: 'ArrowUp' }, { padAxis: 1, dir: -1 }],
      down: [{ key: 'KeyS' }, { key: 'ArrowDown' }, { padAxis: 1, dir: 1 }],
      dash: [{ key: 'Space' }, { padButton: 0 }],
    },
    { getGamepads },
  );
  // The transform is set from the start so recorded pointer positions map the same way on replay.
  input.setPointerTransform((x, y) => surface.clientToLogical(x, y));

  const recorder = createInputRecorder(input);
  const recordedKeys: string[] = [];
  let tick = 0;
  let playback: InputPlayback | null = null;

  const finishRecording = (): void => {
    const recording = recorder.stop();
    state.recordedTicks = recorder.ticks;
    state.positionAfterRecord = [state.position[0], state.position[1]];
    state.json = serializeRecording(recording);
    state.roundTrip = serializeRecording(parseRecording(state.json)) === state.json;
    state.position = [START[0], START[1]];
    // The replay starts from the same clean input state the recording did.
    input.releaseAll();
    input.update();
    playback = createInputPlayback(input, recording);
    state.phase = 'replay';
  };

  const finishReplay = (pb: InputPlayback): void => {
    pb.detach();
    playback = null;
    state.positionAfterReplay = [state.position[0], state.position[1]];
    const a = state.positionAfterRecord!;
    const b = state.positionAfterReplay;
    state.equal = state.mismatches === 0 && a[0] === b[0] && a[1] === b[1];
    // Live from here: real keys, pointer and pads.
    realPads = true;
    input.attach({ pointerTarget: surface.canvas });
    state.phase = 'live';
  };

  const loop = new GameLoop({
    update(dt) {
      if (state.phase === 'record') {
        scriptTick(tick, input);
        input.update();
        recordedKeys.push(stateKey(input));
        moveSprite(input, dt);
        tick++;
        if (tick === SCRIPT_TICKS) finishRecording();
        return;
      }
      if (playback) {
        playback.step();
        input.update();
        const t = playback.tick - 1;
        const key = stateKey(input);
        if (key !== recordedKeys[t]) {
          state.mismatches++;
          state.firstMismatch ??= { tick: t, recorded: recordedKeys[t]!, replayed: key };
        }
        moveSprite(input, dt);
        state.replayTick = playback.tick;
        if (playback.done) finishReplay(playback);
        return;
      }
      input.update();
      moveSprite(input, dt);
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.07, 0.08, 0.12);
      const tint: [number, number, number, number] =
        state.phase === 'record'
          ? [0.95, 0.45, 0.2, 1]
          : state.phase === 'replay'
            ? [0.3, 0.7, 0.95, 1]
            : [0.5, 0.9, 0.5, 1];
      frame.sprite(null, { x: state.position[0], y: state.position[1], w: 80, h: 80, tint });
      renderer.endFrame();
      state.frames++;
      state.gpuErrors = gpuDiagnostics.errorCount;
    },
  });
  res.onDeviceLost(() => loop.stop());
  loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
