import {renderHook} from '@testing-library/react-native';

import useCopySelectionEvent from '@hooks/useCopySelectionEvent';

import getClipboardText from '@libs/Clipboard/getClipboardText';
import SelectionScraper from '@libs/SelectionScraper';

jest.mock('@libs/SelectionScraper', () => ({
    __esModule: true,
    default: {
        getCurrentSelection: jest.fn(),
    },
}));

jest.mock('@libs/Clipboard/getClipboardText', () => ({
    __esModule: true,
    default: jest.fn(),
}));

const mockedGetCurrentSelection = jest.mocked(SelectionScraper.getCurrentSelection);
const mockedGetClipboardText = jest.mocked(getClipboardText);

type MockClipboardData = {
    clearData: jest.Mock;
    setData: jest.Mock;
    getData: jest.Mock;
};

function createCopyEvent(): {event: ClipboardEvent; clipboardData: MockClipboardData} {
    const event = new ClipboardEvent('copy');
    const clipboardData: MockClipboardData = {
        clearData: jest.fn(),
        setData: jest.fn(),
        getData: jest.fn(),
    };
    Object.defineProperty(event, 'clipboardData', {value: clipboardData});
    return {event, clipboardData};
}

describe('useCopySelectionEvent', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('leaves the browser copy untouched when the scrape yields no text', () => {
        // Given the document copy handler is mounted and the selection scraper returns
        // nothing the clipboard helper can turn into text
        renderHook(() => useCopySelectionEvent());
        mockedGetCurrentSelection.mockReturnValue('<p><br></p>');
        mockedGetClipboardText.mockReturnValue('');
        const {event, clipboardData} = createCopyEvent();
        const preventDefaultSpy = jest.spyOn(event, 'preventDefault');

        // When a copy event fires on the document
        document.dispatchEvent(event);

        // Then the handler does not cancel the native copy and does not touch the clipboard,
        // so the browser copies the selected text instead of an empty string
        expect(preventDefaultSpy).not.toHaveBeenCalled();
        expect(clipboardData.clearData).not.toHaveBeenCalled();
        expect(clipboardData.setData).not.toHaveBeenCalled();
    });

    it('leaves the browser copy untouched when the scrape yields only whitespace', () => {
        // Given the document copy handler is mounted and the scraped text is whitespace only
        renderHook(() => useCopySelectionEvent());
        mockedGetCurrentSelection.mockReturnValue('<p>   </p>');
        mockedGetClipboardText.mockReturnValue('   ');
        const {event, clipboardData} = createCopyEvent();
        const preventDefaultSpy = jest.spyOn(event, 'preventDefault');

        // When a copy event fires on the document
        document.dispatchEvent(event);

        // Then the handler does not cancel the native copy
        expect(preventDefaultSpy).not.toHaveBeenCalled();
        expect(clipboardData.setData).not.toHaveBeenCalled();
    });

    it('rewrites the clipboard when the scrape yields real text', () => {
        // Given the document copy handler is mounted and the scraper returns copyable content
        renderHook(() => useCopySelectionEvent());
        mockedGetCurrentSelection.mockReturnValue('<p>hello</p>');
        mockedGetClipboardText.mockReturnValue('hello');
        const {event, clipboardData} = createCopyEvent();
        const preventDefaultSpy = jest.spyOn(event, 'preventDefault');

        // When a copy event fires on the document
        document.dispatchEvent(event);

        // Then the handler takes over the copy with the scraped content, and does not clear
        // the clipboard first, so other clipboard flavours survive
        expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
        expect(clipboardData.clearData).not.toHaveBeenCalled();
        expect(clipboardData.setData).toHaveBeenCalledWith('text/html', '<p>hello</p>');
        expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', 'hello');
    });

    it('returns early when the copy event is already default-prevented', () => {
        // Given the document copy handler is mounted and the event was already handled
        // by another listener, for example the composer's own copy handler
        renderHook(() => useCopySelectionEvent());
        const {event, clipboardData} = createCopyEvent();
        event.preventDefault();
        const preventDefaultSpy = jest.spyOn(event, 'preventDefault');

        // When the already-prevented copy event fires on the document
        document.dispatchEvent(event);

        // Then the handler does not run the scraper and does not touch the clipboard
        expect(mockedGetCurrentSelection).not.toHaveBeenCalled();
        expect(preventDefaultSpy).not.toHaveBeenCalled();
        expect(clipboardData.setData).not.toHaveBeenCalled();
    });

    it('returns early for a selection inside an editable target', () => {
        // Given the document copy handler is mounted and the selection sits inside
        // a contenteditable element, so the element owns the copy
        renderHook(() => useCopySelectionEvent());
        const editable = document.createElement('div');
        editable.contentEditable = 'true';
        editable.textContent = 'composer text';
        document.body.appendChild(editable);
        const range = document.createRange();
        range.selectNodeContents(editable);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        const {event, clipboardData} = createCopyEvent();
        const preventDefaultSpy = jest.spyOn(event, 'preventDefault');

        // When a copy event fires on the editable element
        editable.dispatchEvent(event);

        // Then the handler leaves the copy to the editable element
        expect(preventDefaultSpy).not.toHaveBeenCalled();
        expect(clipboardData.setData).not.toHaveBeenCalled();

        editable.remove();
        selection?.removeAllRanges();
    });
});
