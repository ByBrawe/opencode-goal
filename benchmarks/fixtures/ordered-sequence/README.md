# Ordered sequence benchmark fixture

This workspace intentionally starts without `order.log`.

The stateful benchmark queues two future Goals before activating either one. Intermediate oracles require the queue to remain inert. After explicit promotion of the first Goal, successful ordered progression should eventually produce exactly:

```text
first
second
```

in `order.log`.
