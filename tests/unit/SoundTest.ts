/**
 * Tests for the native sound layer (src/libs/Sound/index.native.ts).
 *
 * These cover the fix for Expensify #106955, where player.play() throws
 * "Session activation failed" on iOS and the rejection escaped as an
 * unhandled rejection because nothing in the sound layer caught it. The
 * native audio module and AppState are mocked, so no real sound plays.
 */

const mockIsVisible = jest.fn(() => true);
const mockLogHmmm = jest.fn();
const mockPlay = jest.fn();
const mockPlayerRemove = jest.fn();
const mockAddListener = jest.fn((_eventName: string, _listener: (status: {didJustFinish: boolean}) => void) => ({remove: jest.fn()}));
const mockCreateAudioPlayer = jest.fn(() => ({play: mockPlay, remove: mockPlayerRemove, addListener: mockAddListener}));
const mockSetAudioModeAsync = jest.fn((): Promise<void> => Promise.resolve());

jest.mock('expo-audio', () => ({
    __esModule: true,
    setAudioModeAsync: mockSetAudioModeAsync,
    createAudioPlayer: mockCreateAudioPlayer,
}));

jest.mock('@libs/Visibility', () => ({
    __esModule: true,
    default: {isVisible: mockIsVisible},
}));

jest.mock('@libs/Log', () => ({
    __esModule: true,
    default: {hmmm: mockLogHmmm},
}));

jest.mock('react-native-onyx');

// The queue spaces sounds out by this long, matching the 300ms passed to
// withMinimalExecutionTime in src/libs/Sound/index.native.ts.
const MIN_EXECUTION_TIME_MS = 300;

// The promise chains in these tests settle within a few ticks, so ten iterations leaves headroom.
const MICROTASK_FLUSH_ITERATIONS = 10;

/**
 * Loads a fresh copy of the native sound module. A fresh module is needed
 * because audio mode is configured once at import time, so each test that
 * changes how setAudioModeAsync behaves needs its own module instance.
 */
const loadPlaySound = async () => {
    jest.resetModules();
    const soundModule = await import('@libs/Sound/index.native');
    return {playSound: soundModule.default, SOUNDS: soundModule.SOUNDS};
};

/**
 * Lets pending promise callbacks run. Fake timers are enabled globally, so a
 * setTimeout-based flush would never fire on its own.
 */
const flushMicrotasks = async () => {
    for (let i = 0; i < MICROTASK_FLUSH_ITERATIONS; i++) {
        await Promise.resolve();
    }
};

describe('playSound (native)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockIsVisible.mockReturnValue(true);
        mockSetAudioModeAsync.mockImplementation(() => Promise.resolve());
        mockPlay.mockImplementation(() => undefined);
    });

    it('does not create a player when the app is already backgrounded', async () => {
        // Given the app is in the background when a sound is requested
        mockIsVisible.mockReturnValue(false);
        const {playSound, SOUNDS} = await loadPlaySound();

        // When the sound is played
        await playSound(SOUNDS.DONE);
        await flushMicrotasks();

        // Then no player is created because iOS refuses to activate the audio session while backgrounded
        expect(mockCreateAudioPlayer).not.toHaveBeenCalled();
        expect(mockPlay).not.toHaveBeenCalled();
    });

    it('does not create a player when the app goes to the background while audio mode is being configured', async () => {
        // Given audio mode configuration is still pending when a sound is requested
        let resolveAudioModeConfigured = () => {};
        const audioModeConfigured = new Promise<void>((resolve) => {
            resolveAudioModeConfigured = resolve;
        });
        mockSetAudioModeAsync.mockImplementation(() => audioModeConfigured);
        const {playSound, SOUNDS} = await loadPlaySound();

        // When the app goes to the background before configuration finishes, then configuration finishes
        const playPromise = playSound(SOUNDS.DONE);
        mockIsVisible.mockReturnValue(false);
        resolveAudioModeConfigured();
        await playPromise;
        await flushMicrotasks();

        // Then no player is created because the visibility check after the await sees the app is backgrounded
        expect(mockCreateAudioPlayer).not.toHaveBeenCalled();
    });

    it('releases the player and logs when play() throws in the foreground', async () => {
        // Given the app is in the foreground and the native player refuses to start, as happens when a call holds the audio session
        const subscriptionRemove = jest.fn();
        mockAddListener.mockReturnValueOnce({remove: subscriptionRemove});
        mockPlay.mockImplementationOnce(() => {
            throw new Error('Session activation failed');
        });
        const {playSound, SOUNDS} = await loadPlaySound();

        // When the sound is played
        await playSound(SOUNDS.DONE);
        await flushMicrotasks();

        // Then the failure is logged instead of surfacing as an unhandled rejection, and the player does not leak
        expect(mockLogHmmm).toHaveBeenCalledWith('[sound] Failed to play sound', expect.objectContaining({soundFile: SOUNDS.DONE}));
        expect(subscriptionRemove).toHaveBeenCalledTimes(1);
        expect(mockPlayerRemove).toHaveBeenCalledTimes(1);
    });

    it('resolves without leaking when creating the player throws', async () => {
        // Given the native player cannot be created at all
        mockCreateAudioPlayer.mockImplementationOnce(() => {
            throw new Error('Failed to create player');
        });
        const {playSound, SOUNDS} = await loadPlaySound();

        // When the sound is played
        await playSound(SOUNDS.DONE);
        await flushMicrotasks();

        // Then the failure is logged and nothing is left behind to remove, because setup threw before any handle existed
        expect(mockLogHmmm).toHaveBeenCalledWith('[sound] Failed to play sound', expect.objectContaining({soundFile: SOUNDS.DONE}));
        expect(mockAddListener).not.toHaveBeenCalled();
        expect(mockPlayerRemove).not.toHaveBeenCalled();
    });

    it('still plays later sounds when audio mode configuration rejects', async () => {
        // Given audio mode configuration fails at startup
        mockSetAudioModeAsync.mockRejectedValue(new Error('Failed to configure audio mode'));
        const {playSound, SOUNDS} = await loadPlaySound();
        await flushMicrotasks();

        // When a sound is played afterwards
        await playSound(SOUNDS.DONE);
        await flushMicrotasks();

        // Then the configuration failure is logged once and playback still proceeds instead of throwing on every await
        expect(mockLogHmmm).toHaveBeenCalledWith('[sound] Failed to configure the audio mode', expect.objectContaining({message: 'Failed to configure audio mode'}));
        expect(mockCreateAudioPlayer).toHaveBeenCalledTimes(1);
        expect(mockPlay).toHaveBeenCalledTimes(1);
    });

    it('keeps the queue moving when a queued sound fails', async () => {
        // Given the first queued sound fails while the second waits behind it
        mockPlay.mockImplementationOnce(() => {
            throw new Error('Session activation failed');
        });
        const {playSound, SOUNDS} = await loadPlaySound();

        // When two sounds are queued back to back
        const firstPlay = playSound(SOUNDS.DONE);
        const secondPlay = playSound(SOUNDS.SUCCESS);
        await firstPlay;
        await flushMicrotasks();

        // Then the first failure is logged and the second sound has not started yet because the queue spacing has not elapsed
        expect(mockLogHmmm).toHaveBeenCalledWith('[sound] Failed to play sound', expect.objectContaining({soundFile: SOUNDS.DONE}));
        expect(mockCreateAudioPlayer).toHaveBeenCalledTimes(1);

        // When the queue spacing elapses
        await jest.advanceTimersByTimeAsync(MIN_EXECUTION_TIME_MS);
        await secondPlay;
        await flushMicrotasks();

        // Then the second sound plays, so one failed sound never blocks the queue
        expect(mockCreateAudioPlayer).toHaveBeenCalledTimes(2);
        expect(mockPlay).toHaveBeenCalledTimes(2);
    });

    it('plays once and releases the player exactly once when playback finishes', async () => {
        // Given the app is in the foreground and playback succeeds
        const subscriptionRemove = jest.fn();
        mockAddListener.mockReturnValueOnce({remove: subscriptionRemove});
        const {playSound, SOUNDS} = await loadPlaySound();

        // When the sound is played and finishes
        await playSound(SOUNDS.DONE);
        await flushMicrotasks();
        const statusListener = mockAddListener.mock.calls[0]?.[1];
        statusListener?.({didJustFinish: true});

        // Then the sound played once and the listener and the player were each removed exactly once
        expect(mockCreateAudioPlayer).toHaveBeenCalledTimes(1);
        expect(mockPlay).toHaveBeenCalledTimes(1);
        expect(subscriptionRemove).toHaveBeenCalledTimes(1);
        expect(mockPlayerRemove).toHaveBeenCalledTimes(1);
        expect(mockLogHmmm).not.toHaveBeenCalled();
    });
});
