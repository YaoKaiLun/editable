import ReactDOM from 'react-dom'
import {
  Editor,
  Node,
  Path,
  Operation,
  Transforms,
  Range,
  Point,
  List,
  Key,
} from '@editablejs/models'
import { Editable, RenderElementProps, RenderLeafProps } from './editable'
import {
  EDITOR_TO_KEY_TO_ELEMENT,
  NODE_TO_KEY,
  IS_SHIFT_PRESSED,
  EDITOR_TO_INPUT,
  EDITOR_TO_SHADOW,
} from '../utils/weak-maps'
import { findCurrentLineRange } from '../utils/lines'
import { EventEmitter } from './event'
import { Placeholder } from './placeholder'
import { Focused } from '../hooks/use-focused'
import { canForceTakeFocus } from '../utils/dom'
import { withInput } from './with-input'
import { withKeydown } from './with-keydown'
import { withNormalizeNode } from './with-normalize-node'
import { withDataTransfer } from './with-data-transfer'

/**
 * `withEditable` adds React and DOM specific behaviors to the editor.
 *
 * If you are using TypeScript, you must extend Slate's CustomTypes to use
 * this plugin.
 *
 * See https://docs.slatejs.org/concepts/11-typescript to learn how.
 */
export const withEditable = <T extends Editor>(editor: T) => {
  const e = editor as T & Editable

  withInput(e)

  withKeydown(e)

  withNormalizeNode(e)

  withDataTransfer(e)

  const { apply, onChange, deleteBackward, deleteForward } = e

  // The WeakMap which maps a key to a specific HTMLElement must be scoped to the editor instance to
  // avoid collisions between editors in the DOM that share the same value.
  EDITOR_TO_KEY_TO_ELEMENT.set(e, new WeakMap())

  e.deleteForward = unit => {
    const { selection } = editor

    if (selection && Range.isCollapsed(selection)) {
      const [cell] = Editor.nodes(editor, {
        match: n => e.isGridCell(n),
      })

      if (cell) {
        const [, cellPath] = cell
        const end = Editor.end(editor, cellPath)
        if (Point.equals(selection.anchor, end)) {
          return
        }
      }
    }
    deleteForward(unit)
  }

  e.deleteBackward = unit => {
    const { selection } = editor

    if (selection && Range.isCollapsed(selection)) {
      const [cell] = Editor.nodes(editor, {
        match: n => e.isGridCell(n),
      })

      if (cell) {
        const [, cellPath] = cell
        const start = Editor.start(editor, cellPath)

        if (Point.equals(selection.anchor, start)) {
          return
        }
      }
      const list = List.above(e)
      if (list && Editor.isStart(e, selection.focus, list[1])) {
        List.unwrapList(e)
        return
      }
    }
    if (unit !== 'line') {
      return deleteBackward(unit)
    }

    if (selection && Range.isCollapsed(selection)) {
      const parentBlockEntry = Editor.above(editor, {
        match: n => Editor.isBlock(editor, n),
        at: selection,
      })

      if (parentBlockEntry) {
        const [, parentBlockPath] = parentBlockEntry
        const parentElementRange = Editor.range(editor, parentBlockPath, selection.anchor)

        const currentLineRange = findCurrentLineRange(e, parentElementRange)

        if (!Range.isCollapsed(currentLineRange)) {
          Transforms.delete(editor, { at: currentLineRange })
        }
      }
    }
  }

  // This attempts to reset the NODE_TO_KEY entry to the correct value
  // as apply() changes the object reference and hence invalidates the NODE_TO_KEY entry
  e.apply = (op: Operation) => {
    const matches: [Path, Key][] = []

    switch (op.type) {
      case 'insert_text':
      case 'remove_text':
      case 'set_node':
      case 'split_node': {
        matches.push(...getMatches(e, op.path))
        break
      }

      case 'set_selection': {
        break
      }

      case 'insert_node':
      case 'remove_node': {
        matches.push(...getMatches(e, Path.parent(op.path)))
        break
      }

      case 'merge_node': {
        const prevPath = Path.previous(op.path)
        matches.push(...getMatches(e, prevPath))
        break
      }

      case 'move_node': {
        const commonPath = Path.common(Path.parent(op.path), Path.parent(op.newPath))
        matches.push(...getMatches(e, commonPath))
        break
      }
    }

    apply(op)

    for (const [path, key] of matches) {
      const [node] = Editor.node(e, path)
      NODE_TO_KEY.set(node, key)
    }
    if (!Editable.isFocused(e) && canForceTakeFocus()) {
      e.focus()
    }
  }

  e.on = (type, handler, prepend) => {
    EventEmitter.on(e, type, handler, prepend)
  }

  e.off = (type, handler) => {
    EventEmitter.off(e, type, handler)
  }

  e.once = (type, handler, prepend) => {
    EventEmitter.on(e, type, handler, prepend)
  }

  e.emit = (type, ...args) => {
    EventEmitter.emit(e, type, ...args)
  }

  let prevSelection: Range | null = null
  let prevAnchorNode: Node | null = null
  let prevFocusNode: Node | null = null

  e.onChange = () => {
    // COMPAT: React doesn't batch `setState` hook calls, which means that the
    // children and selection can get out of sync for one render pass. So we
    // have to use this unstable API to ensure it batches them. (2019/12/03)
    // https://github.com/facebook/react/issues/14259#issuecomment-439702367
    ReactDOM.unstable_batchedUpdates(() => {
      if (
        ((!prevSelection || !e.selection) && prevSelection !== e.selection) ||
        (prevSelection &&
          e.selection &&
          (!Range.equals(prevSelection, e.selection) ||
            prevAnchorNode !== Node.get(e, e.selection.anchor.path) ||
            prevFocusNode !== Node.get(e, e.selection.focus.path)))
      ) {
        e.onSelectionChange()
        prevSelection = e.selection ? Object.assign({}, e.selection) : null
        prevAnchorNode = e.selection ? Node.get(e, e.selection.anchor.path) : null
        prevFocusNode = e.selection ? Node.get(e, e.selection.focus.path) : null
      }
      Placeholder.clearCurrent(e)
      if (e.selection && Range.isCollapsed(e.selection) && Focused.is(e)) {
        const nodes = Editor.nodes(e, {
          at: e.selection,
        })
        for (const entry of nodes) {
          if (Editor.isEmpty(e, entry[0])) {
            Placeholder.setCurrent(e, entry)
            break
          }
        }
      } else if (Editor.isEmpty(e, e)) {
        Placeholder.setCurrent(e, [e, []])
      }

      onChange()
      e.emit('change')
    })
  }

  e.blur = (): void => {
    const shadow = EDITOR_TO_SHADOW.get(editor)
    const textarea = EDITOR_TO_INPUT.get(editor)
    if (textarea && shadow && shadow.activeElement !== textarea) {
      textarea.blur()
    }
  }
  /**
   * Focus the editor.
   */
  e.focus = (start): void => {
    if (!editor.selection) {
      const path = Editable.findPath(e, e)
      const point = start ? Editor.start(e, path) : Editor.end(e, path)
      Transforms.select(e, point)
    } else if (start === true) {
      const path = Editable.findPath(e, e)
      Transforms.select(e, Editor.start(e, path))
    } else if (start === false) {
      const path = Editable.findPath(e, e)
      Transforms.select(e, Editor.start(e, path))
    }

    const shadow = EDITOR_TO_SHADOW.get(editor)
    const textarea = EDITOR_TO_INPUT.get(editor)
    if (textarea && shadow && shadow.activeElement !== textarea) {
      textarea.focus({ preventScroll: true })
    }
  }

  e.onKeyup = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() === 'shift') {
      IS_SHIFT_PRESSED.set(editor, false)
    }
    e.emit('keyup', event)
  }

  e.onFocus = () => {
    e.focus()
    e.emit('focus')
  }

  e.onBlur = () => {
    e.emit('blur')
  }

  e.onSelectStart = () => {
    e.emit('selectstart')
  }

  e.onSelecting = () => {
    e.emit('selecting')
  }

  e.onSelectEnd = () => {
    e.emit('selectend')
  }

  e.onSelectionChange = () => {
    e.emit('selectionchange')
  }

  e.onContextMenu = event => {
    e.emit('contextmenu', event)
  }

  e.onDestory = () => {
    e.emit('destory')
  }

  e.renderElementAttributes = ({ attributes }) => {
    return attributes
  }

  e.renderLeafAttributes = ({ attributes }) => {
    return attributes
  }

  e.renderElement = (props: RenderElementProps) => {
    const { attributes, children, element } = props
    const Tag = e.isInline(element) ? 'span' : 'div'
    return <Tag {...attributes}>{children}</Tag>
  }

  e.renderLeaf = (props: RenderLeafProps) => {
    const { attributes, children } = props
    return <span {...attributes}>{children}</span>
  }

  e.renderPlaceholder = ({ attributes, children }) => {
    return (
      <span style={{ pointerEvents: 'none', userSelect: 'none', position: 'relative' }}>
        <span
          style={{
            position: 'absolute',
            opacity: '0.333',
            width: 'fit-content',
            whiteSpace: 'nowrap',
            textIndent: 'initial',
          }}
          {...attributes}
        >
          {children}
        </span>
      </span>
    )
  }

  const { insertBreak } = e

  e.insertBreak = () => {
    const { selection } = editor

    if (!Editable.isEditor(editor) || !selection || Range.isExpanded(selection)) {
      insertBreak()
      return
    }
    const entrie = List.above(editor)
    if (!entrie) {
      insertBreak()
      return
    }
    List.splitList(editor)
  }

  e.insertFile = (_, range) => {
    if (range) {
      Transforms.select(e, range)
    }
  }

  return e
}

const getMatches = (e: Editable, path: Path) => {
  const matches: [Path, Key][] = []
  for (const [n, p] of Editor.levels(e, { at: path })) {
    const key = Editable.findKey(e, n)
    matches.push([p, key])
  }
  return matches
}
