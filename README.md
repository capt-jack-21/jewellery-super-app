# Jewellery super app (working name)

A multi-tenant SaaS for Indian jewellery shops: masters, daily rates, stock, GST billing, custom orders and repairs.
Each shop's data is kept apart with PostgreSQL row-level security. **View only: see LICENSE. All rights reserved.**

## What is built
Platform (tenants, users, roles, devices), Masters, Rates, Inventory (tags, lots, transfers), Sales (GST bills, estimates,
credit notes, receipts, prints), Orders and Repairs (orders, advances, vendors, repair bills, prints).
Purchases, Refinery, Accounts, HR, Approvals, Reports, Notifications and SaaS billing are planned and not built yet.

## Stack
TypeScript, Node 24, NestJS on Fastify, pnpm and Turborepo, PostgreSQL 17 with hand-written SQL migrations,
OpenAPI 3.1 contract-first (`backend/contracts/openapi.yaml`), React 19 and Vite (English and Tamil).

## Layout
```
backend/               API and worker; one package per module under packages/modules
frontend/              React app
jewellery-data-model/  SQL migrations (the source of truth for the database)
docs/                  architecture, spec, freeze lists, user guide
```
This is a snapshot of a private repository, published without its history, server setup and operations files.
