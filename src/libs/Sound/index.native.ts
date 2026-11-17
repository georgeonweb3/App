import attentionSound from '@assets/sounds/attention.mp3';
import doneSound from '@assets/sounds/done.mp3';
import receiveSound from '@assets/sounds/receive.mp3';
import successSound from '@assets/sounds/success.mp3';

import type {AudioSource} from 'expo-audio';
import type {ValueOf} from 'type-fest';

import {createAudioPlayer, setAudioModeAsync} from 'expo-audio';

import {getErrorMessage} from '@libs/ErrorUtils';
import Log from '@libs/Log';
import Visibility from '@libs/Visibility';

import {getIsMuted, SOUNDS, withMinimalExecutionTime} from './BaseSound';

// Sound assets are statically imported for bundling.
const SOUND_ASSETS = {
    [SOUNDS.DONE]: doneSound,
    [SOUNDS.SUCCESS]: successSound,
    [SOUNDS.ATTENTION]: attentionSound,
    [SOUNDS.RECEIVE]: receiveSound,
} satisfies Record<ValueOf<typeof SOUNDS>, Extract<AudioSource, number | string>>;

// Configure audio mode for in-app notification sounds:
// - playsInSilentMode: false — respect the device's silent/mute switch (iOS)
// - shouldPlayInBackground: false — push notification sounds are played by the system
// - interruptionMode: 'mixWithOthers' — don't interrupt other audio (e.g. music)
// A failed configuration must not poison every later playSound call: log it
// once and resolve, so playback degrades to "no sound" instead of throwing
// on every await.
const audioModeConfigured = setAudioModeAsync({playsInSilentMode: false, shouldPlayInBackground: false, interruptionMode: 'mixWithOthers'}).catch((error: unknown) => {
    Log.hmmm('[sound] Failed to configure the audio mode', {message: getErrorMessage(error)});
});

const playSound = async (soundFile: ValueOf<typeof SOUNDS>) => {
    if (getIsMuted()) {
        return;
    }

    // Skip before doing any work when the app is already backgrounded: the
    // user can't hear an in-app sound there, and iOS refuses to activate
    // the audio session.
    if (!Visibility.isVisible()) {
        return;
    }

    const source = SOUND_ASSETS[soundFile];
    if (!source) {
        return;
    }

    // Wait for audio mode to be configured before playing to ensure the session
    // uses the .ambient category (which won't interrupt music or other audio)
    await audioModeConfigured;

    // Re-check after the await: the app can go to the background while we
    // wait (the queue can also hold this call for 300ms). This is the latest
    // point before we touch the native session, so no player is created for
    // a sound that cannot play.
    if (!Visibility.isVisible()) {
        return;
    }

    // createAudioPlayer, addListener and play() all touch the native audio
    // session and can throw. Keep the handles outside the try so the catch
    // can release whatever was actually created, and guard each removal:
    // if setup throws halfway, the other handle may not exist yet.
    let player: ReturnType<typeof createAudioPlayer> | undefined;
    let subscription: {remove: () => void} | undefined;
    try {
        player = createAudioPlayer(source);

        // Listen for playback completion to release resources
        subscription = player.addListener('playbackStatusUpdate', (status) => {
            if (!status.didJustFinish) {
                return;
            }

            subscription?.remove();
            player?.remove();
        });

        player.play();
    } catch (error) {
        // iOS can still refuse the session while the app is in the foreground
        // (a phone call, or another app holding the audio session). A failed
        // UI sound is expected behaviour, not an app error: log it and
        // release whatever was created, so no player leaks.
        subscription?.remove();
        player?.remove();
        Log.hmmm('[sound] Failed to play sound', {soundFile, message: getErrorMessage(error)});
    }
};

function clearSoundAssetsCache() {}

export {SOUNDS, clearSoundAssetsCache};
export default withMinimalExecutionTime(playSound, 300);
