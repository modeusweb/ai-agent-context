# 0001 Use PostgreSQL for transactional data

Status: accepted

Payments and users must be stored transactionally, therefore PostgreSQL is the
primary datastore. The repository layer owns all SQL access.
