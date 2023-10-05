import * as React from 'react'
import {render} from '../'

test('rerender will re-render the element', async () => {
  const Greeting = props => <div>{props.message}</div>
  const {container, rerender} = await render(<Greeting message="hi" />)
  expect(container.firstChild).toHaveTextContent('hi')
  await rerender(<Greeting message="hey" />)
  expect(container.firstChild).toHaveTextContent('hey')
})

test('hydrate will not update props until next render', async () => {
  const initialInputElement = document.createElement('input')
  const container = document.createElement('div')
  container.appendChild(initialInputElement)
  document.body.appendChild(container)

  const firstValue = 'hello'
  initialInputElement.value = firstValue

  const {rerender} = await render(<input value="" onChange={() => null} />, {
    container,
    hydrate: true,
  })

  expect(initialInputElement).toHaveValue(firstValue)

  const secondValue = 'goodbye'
  await rerender(<input value={secondValue} onChange={() => null} />)
  expect(initialInputElement).toHaveValue(secondValue)
})
