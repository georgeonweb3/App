import {getErrorMessage} from '@libs/ErrorUtils';
import getPlatform from '@libs/getPlatform';
import Log from '@libs/Log';

import ONYXKEYS from '@src/ONYXKEYS';

import Onyx from 'react-native-onyx';

let isMuted = false;

// We use `connectWithoutView` here because this is purely for sound utility logic and not connected
// to any UI component. This connection tracks the platform-specific mute state in a module-level
// variable that sound functions check when called, avoiding unnecessary re-renders since.
Onyx.connectWithoutView({
    key: ONYXKEYS.NVP_MUTED_PLATFORMS,
    callback: (val) => {
        const platform = getPlatform(true);
        isMuted = !!val?.[platform];
    },
});

const SOUNDS = {
    DONE: 'done',
    SUCCESS: 'success',
    ATTENTION: 'attention',
    RECEIVE: 'receive',
} as const;

const getIsMuted = () => isMuted;

/**
 * Creates a version of the given function that, when called, queues the execution and ensures that
 * calls are spaced out by at least the specified `minExecutionTime`, even if called more frequently. This allows
 * for throttling frequent calls to a function, ensuring each is executed with a minimum `minExecutionTime` between calls.
 * Each call returns a promise that resolves when the function call is executed, allowing for asynchronous handling.
 */
function withMinimalExecutionTime<F extends (...args: Parameters<F>) => ReturnType<F>>(func: F, minExecutionTime: number) {
    const queue: Array<[() => ReturnType<F>, (value?: unknown) => void]> = [];
    let timerId: NodeJS.Timeout | null = null;

    function processQueue() {
        if (queue.length > 0) {
            const next = queue.shift();

            if (!next) {
                return;
            }

            const [nextFunc, resolve] = next;
            // The same failure is logged whether the queued function throws
            // synchronously or rejects, so both paths share one log call.
            const logQueueFailure = (error: unknown) => Log.hmmm('[sound] Queued sound failed', {message: getErrorMessage(error)});
            try {
                const result: unknown = nextFunc();
                if (result instanceof Promise) {
                    // A queued function that rejects must never surface as an
                    // unhandled rejection. resolve() still runs immediately,
                    // exactly as today, and the 300ms spacing is unchanged:
                    // this only attaches a log handler to the dropped promise.
                    result.catch(logQueueFailure);
                }
            } catch (error) {
                logQueueFailure(error);
            }
            resolve();
            timerId = setTimeout(processQueue, minExecutionTime);
        } else {
            timerId = null;
        }
    }

    return function (...args: Parameters<F>) {
        return new Promise((resolve) => {
            queue.push([() => func(...args), resolve]);

            if (!timerId) {
                // If the timer isn't running, start processing the queue
                processQueue();
            }
        });
    };
}

export {SOUNDS, withMinimalExecutionTime, getIsMuted};
