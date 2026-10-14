// Orders, staff side (M7.1). The tables come from C5 (create_orders); this adds what the
// staff work needs: the customer link, who entered a staff order, when each status was
// reached, the cancel reason and when it was paid. Which status may follow which is
// enforced in `node/src/orders/orders.service.js`; the checks here only keep each row
// consistent with its own status.
exports.up = async function (knex) {
  await knex.schema.alterTable('orders', (t) => {
    // Customers are never deleted; if one ever is, the order keeps its guest snapshot.
    t.foreign('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.uuid('created_by').references('id').inTable('staff_profiles');
    t.string('cancel_reason', 500);
    t.timestamp('confirmed_at', { useTz: true });
    t.timestamp('delivered_at', { useTz: true });
    t.timestamp('closed_at', { useTz: true });
    t.timestamp('cancelled_at', { useTz: true });
    t.timestamp('paid_at', { useTz: true });
  });

  // A shop order comes from a guest; a staff order names the staff member who entered it.
  await knex.raw(
    'alter table orders add constraint orders_created_by_rules check ' +
      "((source = 'shop' and created_by is null) or (source = 'staff' and created_by is not null))",
  );
  // A cancelled order says why, and only a cancelled order has a reason.
  await knex.raw(
    'alter table orders add constraint orders_cancel_rules check ' +
      "((status = 'cancelled') = (cancel_reason is not null and cancelled_at is not null))",
  );
  await knex.raw(
    'alter table orders add constraint orders_paid_rules check ' +
      "((payment_status = 'paid') = (paid_at is not null))",
  );
};

exports.down = async function (knex) {
  await knex.raw('alter table orders drop constraint if exists orders_paid_rules');
  await knex.raw('alter table orders drop constraint if exists orders_cancel_rules');
  await knex.raw('alter table orders drop constraint if exists orders_created_by_rules');
  await knex.schema.alterTable('orders', (t) => {
    t.dropForeign('customer_id');
    t.dropColumn('created_by');
    t.dropColumn('cancel_reason');
    t.dropColumn('confirmed_at');
    t.dropColumn('delivered_at');
    t.dropColumn('closed_at');
    t.dropColumn('cancelled_at');
    t.dropColumn('paid_at');
  });
};
