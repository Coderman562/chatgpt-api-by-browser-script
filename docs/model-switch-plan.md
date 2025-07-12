# Plan for Model Switching

The ChatGPT webpage exposes the active model in two places:

1. **URL search parameters** – The `model` parameter is updated whenever the model
   changes. Example: `https://chatgpt.com/?model=gpt-4o`.
2. **Model picker button** – There is a button near the top left of the page
   containing the current model name. It has a `data-testid` of
   `model-picker`. The text inside the button is the human readable model label
   such as `GPT‑4o` or `GPT‑4‑1`.

When the usage limit of a model is hit the page automatically falls back to a
smaller model. This is reflected by the search parameter and the text in the
picker button changing without user interaction.

To keep scraping with our preferred models we will monitor the current model
using the search parameters. If the page switches to a model that is not in our
preferred list we will update the search parameters with the next model we want
and reload the page so ChatGPT uses it for the next request.

During each answer collection we also record the model name and include it in the
websocket message so the server knows which model produced the response.
