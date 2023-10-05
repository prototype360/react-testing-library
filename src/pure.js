import * as React from 'react'
import ReactDOM from 'react-dom'
import {act as domAct} from 'react-dom/test-utils'
import * as ReactDOMClient from 'react-dom/client'
import {
  getQueriesForElement,
  prettyDOM,
  configure as configureDTL,
} from '@testing-library/dom'
import {
  actIfEnabled,
  getIsReactActEnvironment,
  setIsReactActEnvironment,
} from './act-compat'
import {fireEvent} from './fire-event'

configureDTL({
  unstable_advanceTimersWrapper: actIfEnabled,
  // We just want to run `waitFor` without IS_REACT_ACT_ENVIRONMENT
  // But that's not necessarily how `asyncWrapper` is used since it's a public method.
  // Let's just hope nobody else is using it.
  asyncWrapper: async cb => {
    const previousActEnvironment = getIsReactActEnvironment()
    setIsReactActEnvironment(false)
    try {
      return await cb()
    } finally {
      setIsReactActEnvironment(previousActEnvironment)
    }
  },
  eventWrapper: actIfEnabled,
})

// Ideally we'd just use a WeakMap where containers are keys and roots are values.
// We use two variables so that we can bail out in constant time when we render with a new container (most common use case)
/**
 * @type {Set<import('react-dom').Container>}
 */
const mountedContainers = new Set()
/**
 * @type Array<{container: import('react-dom').Container, root: ReturnType<typeof createConcurrentRoot>}>
 */
const mountedRootEntries = []

async function createConcurrentRoot(
  container,
  {hydrate, ui, wrapper: WrapperComponent},
) {
  let root
  if (hydrate) {
    await actIfEnabled(() => {
      root = ReactDOMClient.hydrateRoot(
        container,
        WrapperComponent ? React.createElement(WrapperComponent, null, ui) : ui,
      )
    })
  } else {
    root = ReactDOMClient.createRoot(container)
  }

  return {
    hydrate() {
      /* istanbul ignore if */
      if (!hydrate) {
        throw new Error(
          'Attempted to hydrate a non-hydrateable root. This is a bug in `@testing-library/react`.',
        )
      }
      // Nothing to do since hydration happens when creating the root object.
    },
    render(element) {
      return actIfEnabled(() => {
        root.render(element)
      })
    },
    unmount() {
      return actIfEnabled(() => {
        root.unmount()
      })
    },
  }
}

async function createLegacyRoot(container) {
  return {
    hydrate(element) {
      return actIfEnabled(() => {
        ReactDOM.hydrate(element, container)
      })
    },
    render(element) {
      return actIfEnabled(() => {
        ReactDOM.render(element, container)
      })
    },
    unmount() {
      return actIfEnabled(() => {
        ReactDOM.unmountComponentAtNode(container)
      })
    },
  }
}

async function renderRoot(
  ui,
  {baseElement, container, hydrate, queries, root, wrapper: WrapperComponent},
) {
  const wrapUiIfNeeded = innerElement =>
    WrapperComponent
      ? React.createElement(WrapperComponent, null, innerElement)
      : innerElement

  if (hydrate) {
    await root.hydrate(wrapUiIfNeeded(ui), container)
  } else {
    await root.render(wrapUiIfNeeded(ui), container)
  }

  return {
    container,
    baseElement,
    debug: (el = baseElement, maxLength, options) =>
      Array.isArray(el)
        ? // eslint-disable-next-line no-console
          el.forEach(e => console.log(prettyDOM(e, maxLength, options)))
        : // eslint-disable-next-line no-console,
          console.log(prettyDOM(el, maxLength, options)),
    unmount: () => {
      return root.unmount()
    },
    rerender: async rerenderUi => {
      await renderRoot(wrapUiIfNeeded(rerenderUi), {
        container,
        baseElement,
        root,
      })
      // Intentionally do not return anything to avoid unnecessarily complicating the API.
      // folks can use all the same utilities we return in the first place that are bound to the container
    },
    asFragment: () => {
      /* istanbul ignore else (old jsdom limitation) */
      if (typeof document.createRange === 'function') {
        return document
          .createRange()
          .createContextualFragment(container.innerHTML)
      } else {
        const template = document.createElement('template')
        template.innerHTML = container.innerHTML
        return template.content
      }
    },
    ...getQueriesForElement(baseElement, queries),
  }
}

async function render(
  ui,
  {
    container,
    baseElement = container,
    legacyRoot = false,
    queries,
    hydrate = false,
    wrapper,
  } = {},
) {
  if (!baseElement) {
    // default to document.body instead of documentElement to avoid output of potentially-large
    // head elements (such as JSS style blocks) in debug output
    baseElement = document.body
  }
  if (!container) {
    container = baseElement.appendChild(document.createElement('div'))
  }

  let root
  // eslint-disable-next-line no-negated-condition -- we want to map the evolution of this over time. The root is created first. Only later is it re-used so we don't want to read the case that happens later first.
  if (!mountedContainers.has(container)) {
    const createRootImpl = legacyRoot ? createLegacyRoot : createConcurrentRoot
    root = await createRootImpl(container, {hydrate, ui, wrapper})

    mountedRootEntries.push({container, root})
    // we'll add it to the mounted containers regardless of whether it's actually
    // added to document.body so the cleanup method works regardless of whether
    // they're passing us a custom container or not.
    mountedContainers.add(container)
  } else {
    mountedRootEntries.forEach(rootEntry => {
      // Else is unreachable since `mountedContainers` has the `container`.
      // Only reachable if one would accidentally add the container to `mountedContainers` but not the root to `mountedRootEntries`
      /* istanbul ignore else */
      if (rootEntry.container === container) {
        root = rootEntry.root
      }
    })
  }

  return renderRoot(ui, {
    container,
    baseElement,
    queries,
    hydrate,
    wrapper,
    root,
  })
}

async function cleanup() {
  for (const {container, root} of mountedRootEntries) {
    // eslint-disable-next-line no-await-in-loop -- Overlapping act calls are not allowed.
    await root.unmount()
    if (container.parentNode === document.body) {
      document.body.removeChild(container)
    }
  }

  mountedRootEntries.length = 0
  mountedContainers.clear()
}

async function renderHook(renderCallback, options = {}) {
  const {initialProps, ...renderOptions} = options
  const result = React.createRef()

  function TestComponent({renderCallbackProps}) {
    const pendingResult = renderCallback(renderCallbackProps)

    React.useEffect(() => {
      result.current = pendingResult
    })

    return null
  }

  const {rerender: baseRerender, unmount} = await render(
    <TestComponent renderCallbackProps={initialProps} />,
    renderOptions,
  )

  function rerender(rerenderCallbackProps) {
    return baseRerender(
      <TestComponent renderCallbackProps={rerenderCallbackProps} />,
    )
  }

  return {result, rerender, unmount}
}

function compatAct(scope) {
  // scope passed to domAct needs to be `async` until React.act treats every scope as async.
  // We already enforce `await act()` (regardless of scope) to flush microtasks
  // inside the act scope.
  return domAct(async () => {
    return scope()
  })
}

// just re-export everything from dom-testing-library
export * from '@testing-library/dom'
export {render, renderHook, cleanup, compatAct as act, fireEvent}

/* eslint func-name-matching:0 */
