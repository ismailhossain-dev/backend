require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRECT_KEY);
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf-8");
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
app.use(cors());

//client link
app.use(
  cors({
    origin: [
      process.env.CLIENT_DOMAIN,
      "https://bookcourier12.vercel.app",
      "http://localhost:5173",
    ],
    credentials: true,
  })
);

app.use(express.json());

const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const db = client.db("bookDB");
const bookCollection = db.collection("books");
const userCollection = db.collection("user");
const ordersCollection = db.collection("orders");
const ContactCollection = db.collection("contactFrom");
const wishlistCollection=db.collection("wishlist")

// Create unique index for transactionId
ordersCollection
  .createIndex(
    { transactionId: 1 },
    { unique: true }
  )
  .then(() => {
    console.log("Orders unique index created successfully");
  })
  .catch((error) => {
    console.error("Index creation failed:", error);
  });

const verifyADMIN = async (req, res, next) => {
  const email = req.tokenEmail;
  const user = await userCollection.findOne({ email });
  if (user?.role !== "admin")
    return res.status(403).send({ message: "Admin only Actions!", role: user?.role });
  next();
};

const verifySELLER = async (req, res, next) => {
  const email = req.tokenEmail;
  const user = await userCollection.findOne({ email });
  if (user?.role !== "seller")
    return res.status(403).send({ message: "Seller only Actions!", role: user?.role });
  next();
};

//user api
app.post("/user", async (req, res) => {
  try {
    const userData = req.body;

    // console.log("gogole login backend", userData);
    if (!userData?.email) {
      return res.status(400).send({ message: "Email is required" });
    }

    const query = { email: userData.email };
    const existingUser = await userCollection.findOne(query);

    if (existingUser) {
      const result = await userCollection.updateOne(query, {
        $set: { lastLoggedIn: new Date() },
      });
      return res.status(200).send({
        message: "User login updated",
        result,
      });
    }

    const newUser = {
      email: userData.email,
      displayName: userData.displayName || "",
      photoURL: userData.photoURL || "",
      role: "user",
      createdAt: new Date(),
      lastLoggedIn: new Date(),
    };

    const result = await userCollection.insertOne(newUser);
    res.status(201).send({
      message: "User created successfully",
      result,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Internal server error" });
  }
});

app.post("/books", async (req, res) => {
  const BookData = req.body;
  const result = await bookCollection.insertOne(BookData);
  res.send(result);
});

app.get("/books", verifyJWT, verifySELLER, async (req, res) => {
  const result = await bookCollection.find().toArray();
  res.send(result);
});

app.get("/books/:id", async (req, res) => {
  const id = req.params.id;
  const result = await bookCollection.findOne({ _id: new ObjectId(id) });
  res.send(result);
});

//wishlist post 
app.post("/wishlist", async (req, res) => {
  try {
    const wishlistData = req.body;
    const { email, productId } = wishlistData;

  
    const query = { email, productId };
    const existingWishlistItem = await wishlistCollection.findOne(query);

    if (existingWishlistItem) {
     
      return res.status(409).send({
        success: false,
        message: "This book is already in your wishlist!",
      });
    }

    const result = await wishlistCollection.insertOne(wishlistData);
    res.send({
      success: true,
      insertedId: result.insertedId,
      message: "Added to wishlist successfully!",
    });
  } catch (error) {
    console.error("Error adding to wishlist:", error);
    res.status(500).send({ success: false, message: "Internal server error" });
  }
});

//wishlist get 

app.get("/wishlist/:email", async (req, res) => {
  try {
    const email = req.params.email;

    const result = await wishlistCollection.find({ email }).toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch wishlist data", error });
  }
});

//wishlist delete

app.delete("/wishlist/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) }; 
    const result = await wishlistCollection.deleteOne(query);

    if (result.deletedCount === 1) {
      res.send({ success: true, deletedCount: 1, message: "Item removed successfully" });
    } else {
      res.status(404).send({ success: false, message: "Item not found" });
    }
  } catch (error) {
    console.error("Error deleting wishlist item:", error);
    res.status(500).send({ success: false, message: "Internal server error", error });
  }
});

app.post("/create-checkout-session", async (req, res) => {
  const paymentInfo = req.body;
  const session = await stripe.checkout.sessions.create({
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: paymentInfo?.customer.name,
            description: paymentInfo?.description,
            images: [paymentInfo?.image],
          },
          unit_amount: paymentInfo.price * 100,
        },
        quantity: 1,
      },
    ],
    mode: "payment",
    metadata: {
      bookId: paymentInfo?.bookId,
      customer: paymentInfo?.customer.email,
    },
    customer_email: paymentInfo.customer.email,
    success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.CLIENT_DOMAIN}/${paymentInfo.bookId}`,
  });
  res.send({ url: session.url });
});



// Payment Success API
app.post("/payment-success", async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "Session ID is required",
      });
    }

    // 1. Retrieve Stripe Session
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    console.log("Stripe Session:", {
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      metadata: session.metadata,
    });

    // 2. Verify payment
    if (
      session.status !== "complete" ||
      session.payment_status !== "paid"
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment not completed",
      });
    }

    // 3. Get metadata
    const bookId = session.metadata?.bookId;

    const customer =
      session.metadata?.customer ||
      session.customer_details?.email;

    if (!bookId || !ObjectId.isValid(bookId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Book ID",
      });
    }

    if (!customer) {
      return res.status(400).json({
        success: false,
        message: "Customer email not found",
      });
    }

    // 4. Get Transaction ID
    const transactionId = session.payment_intent;

    if (!transactionId || typeof transactionId !== "string") {
      return res.status(400).json({
        success: false,
        message: "Transaction ID not found",
      });
    }

    // 5. Check duplicate order
    const existingOrder = await ordersCollection.findOne({
      transactionId,
    });

    if (existingOrder) {
      return res.status(200).json({
        success: true,
        message: "Order already exists",
        orderId: existingOrder._id,
        transactionId,
      });
    }

    // 6. Find Book
    const book = await bookCollection.findOne({
      _id: new ObjectId(bookId),
    });

    if (!book) {
      return res.status(404).json({
        success: false,
        message: "Book not found",
      });
    }

    // 7. Validate payment amount
    const expectedAmount = Math.round(Number(book.price) * 100);

    if (
      session.currency !== "usd" ||
      !Number.isSafeInteger(expectedAmount) ||
      expectedAmount <= 0 ||
      session.amount_total !== expectedAmount
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment amount or currency mismatch",
      });
    }

    // 8. Prepare order
    const orderInfo = {
      bookId,
      sessionId: session.id,
      transactionId,
      customer,
      status: "pending",
      paymentStatus: "paid",
      seller: book.details?.publisher || "",
      name: book.title,
      category: book.category,
      quantity: 1,
      price: session.amount_total / 100,
      image: book.image || "",
      createdAt: new Date(),
    };

    // 9. Save order
    let result;

    try {
      result = await ordersCollection.insertOne(orderInfo);
    } catch (error) {
      // Handle duplicate requests
      if (error.code === 11000) {
        const order = await ordersCollection.findOne({
          transactionId,
        });

        return res.status(200).json({
          success: true,
          message: "Order already exists",
          orderId: order?._id,
          transactionId,
        });
      }

      throw error;
    }

    console.log("Order Saved:", result.insertedId);

    // 10. Update stock only when quantity is available
    const stockResult = await bookCollection.updateOne(
      {
        _id: new ObjectId(bookId),
        quantity: { $gte: 1 },
      },
      {
        $inc: { quantity: -1 },
      }
    );

    console.log("Stock Update:", stockResult.modifiedCount);

    if (stockResult.modifiedCount === 0) {
      console.warn(
        "Order saved, but stock was not reduced:",
        result.insertedId
      );
    }

    // 11. Success response
    return res.status(201).json({
      success: true,
      message:
        stockResult.modifiedCount === 1
          ? "Order saved successfully"
          : "Order saved; stock requires review",
      orderId: result.insertedId,
      transactionId,
      stockUpdated: stockResult.modifiedCount === 1,
    });

  } catch (error) {
    console.error("Payment Success Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to process payment order",
    });
  }
});


app.get("/my-orders", verifyJWT, async (req, res) => {

  console.log(email)
  const result = await ordersCollection.find({ customer: req.tokenEmail }).toArray();
  res.send(result);
});

app.get("/orders/:email", async (req, res) => {
  const query = {};
  const email = req.params.email;
  if (email) {
    query.senderEmail = email;
  }
  const options = { sort: { createdAt: -1 } };
  const cursor = ordersCollection.find(query, options);
  const result = await cursor.toArray();
  res.send(result);
});

app.get("/all-orders", async (req, res) => {
  try {
    const result = await ordersCollection.find().toArray();
    // console.log(result);
    res.status(200).json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

app.get("/my-orders/:email", async (req, res) => {
  try {
    const email = req.params.email;
    const orders = await ordersCollection.find({ customer: email }).toArray();
    res.send(orders);
  } catch (err) {
    res.status(500).send({ error: "Failed to fetch orders" });
  }
});

app.delete("/my-orders/:id", async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await ordersCollection.deleteOne(query);
  res.send(result);
});

app.get("/user/role/:email", verifyJWT, async (req, res) => {
  const result = await userCollection.findOne({ email: req.tokenEmail });
  res.send({ role: result?.role });
});

app.delete("/my-inventory/:id", async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await ordersCollection.deleteOne(query);
  res.send(result);
});

app.delete("/orders/:id", async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await ordersCollection.deleteOne(query);
  res.send(result);
});

app.get("/homeBooks", async (req, res) => {
  const result = await bookCollection.find().limit(8).sort({ price: 1 }).toArray();
  // console.log("ami home books boltechi",result)
  res.send(result);
});

app.get("/allBooks", async (req, res) => {
  const result = await bookCollection.find().sort({ price: 1 }).toArray();
  res.send(result);
});

app.post("/contact", async (req, res) => {
  const newProduct = req.body;
  const result = await ContactCollection.insertOne(newProduct);
  res.send(result);
});

app.get("/users", verifyJWT, verifyADMIN, async (req, res) => {
  const adminEmail = req.tokenEmail;
  const result = await userCollection.find({ email: { $ne: adminEmail } }).toArray();
  res.send(result);
});

app.delete("/users/:id", async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await userCollection.deleteOne(query);
  res.send(result);
});

app.patch("/users/:email", async (req, res) => {
  const email = req.params.email;
  const userInfo = req.body;
  const query = { email };
  const updateDoc = {
    $set: { displayName: userInfo.displayName },
  };
  const result = await userCollection.updateOne(query, updateDoc);
  res.send(result);
});

//main profile update
app.patch("/user-profile/:email", async (req, res) => {
  const email = req.params.email;
  const profileInfo = req.body;

  const query = { email: email };

  const updateDoc = {
    $set: {
      displayName: profileInfo.displayName,
      photoURL: profileInfo.photoURL,
    },
  };

  const result = await userCollection.updateOne(query, updateDoc);
  res.send(result);
});


app.get("/get-all-overview/:email", async (req, res) => {
  try {
    const email = req.params.email;

    const totalOrders = await ordersCollection.countDocuments({
      customer: email,
    });

    const pendingOrders = await ordersCollection.countDocuments({
      customer: email,
      status: "pending",
    });


    const completedOrders = await ordersCollection.countDocuments({
      customer: email,
      status: "completed",
    });


    const wishlistCount = await wishlistCollection.countDocuments({
      email: email,
    });

    const orders = await ordersCollection
      .find({ customer: email })
      .toArray();
    //date
    const monthlyCounts = {
      Jan: 0, Feb: 0, Mar: 0, Apr: 0, May: 0, Jun: 0,
      Jul: 0, Aug: 0, Sep: 0, Oct: 0, Nov: 0, Dec: 0,
    };

    orders.forEach((order) => {
      const date = order.createdAt ? new Date(order.createdAt) : new Date();
      const monthName = date.toLocaleString("en-US", { month: "short" });
      if (monthlyCounts[monthName] !== undefined) {
        monthlyCounts[monthName] += 1;
      }
    });

    res.send({
      totalOrders,
      pendingOrders,
      completedOrders,
      wishlistCount,
      monthlyCounts,
    });
  } catch (error) {
    console.error("Error fetching overview data:", error);
    res.status(500).send({ message: "Failed to fetch overview data" });
  }
});

app.get("/manage-books", async (req, res) => {
  const result = await ordersCollection.find().toArray();
  res.send(result);
});

app.patch("/users-profile/:email", async (req, res) => {
  const email = req.params.email;
  const profileInfo = req.body;
  const query = { email: email };
  const updateDoc = {
    $set: {
      displayName: profileInfo.displayName,
      photoURL: profileInfo.photoURL,
    },
  };
  const result = await userCollection.updateOne(query, updateDoc);
  res.send(result);
});

app.delete("/manage-books/:id", async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await ordersCollection.deleteOne(query);
  res.send(result);
});

app.patch("/manage-books/:email", async (req, res) => {
  const email = req.params.email;
  const bookInfo = req.body;
  const query = { email: email };
  const updateDoc = { $set: bookInfo };
  const result = await ordersCollection.updateOne(query, updateDoc);
  res.send(result);
});

console.log("Pinged your deployment. You successfully connected to MongoDB!");

app.get("/", (req, res) => {
  res.send("Nice BookCourier project");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
